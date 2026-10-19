/**
 * Olm sessions per remote device (ADR 0003). Sessions live in the store as pickles; restored
 * objects are cached here. Callers hold the engine lock: the account and the sessions are
 * mutated synchronously and must be persisted (`record.pickle`) in the same batch as whatever
 * the operation produced.
 *
 * - Encrypting uses the most recently active session with the device, so both sides converge
 *   on one session after a simultaneous start or a repair.
 * - A pre-key message goes to the existing session with its ID (`prekeyMessageSessionId`);
 *   only when none matches does it open a new inbound session, which consumes a one-time key.
 * - A normal message is tried against the device's sessions, most recent first.
 */
import type { CryptoProvider, OlmAccount, OlmCiphertext, OlmSession } from '@pingdost/crypto/core';

import type { EngineStore, SessionRecord } from './store';

export interface RemoteDevice {
  deviceId: string;
  userId: string;
  curve25519: string;
}

export type DecryptResult =
  | {
      ok: true;
      plaintext: Uint8Array;
      /** The session with its new pickle; store it with the result. */
      session: SessionRecord;
      /** A new inbound session consumed a one-time key: store the account too. */
      accountChanged: boolean;
    }
  | { ok: false; sessionId: string | undefined };

/** Most recently active first. */
function byActivity(a: SessionRecord, b: SessionRecord): number {
  return Math.max(b.lastReceivedAt, b.createdAt) - Math.max(a.lastReceivedAt, a.createdAt);
}

export class SessionManager {
  readonly #cache = new Map<string, OlmSession>();

  constructor(
    private readonly crypto: CryptoProvider,
    private readonly account: OlmAccount,
    private readonly pickleKey: Uint8Array,
    private readonly store: EngineStore,
  ) {}

  /** The session to encrypt to `device` with, if there is one. */
  async preferred(device: RemoteDevice): Promise<SessionRecord | undefined> {
    const sessions = await this.#sessionsOf(device);
    return sessions.sort(byActivity)[0];
  }

  /** A new outbound session from a claimed (and signature-checked) one-time or fallback key. */
  createOutbound(device: RemoteDevice, oneTimeKey: string, now: number): SessionRecord {
    const session = this.account.createOutboundSession(device.curve25519, oneTimeKey);
    const sessionId = session.sessionId();
    this.#cache.get(sessionId)?.dispose();
    this.#cache.set(sessionId, session);
    return {
      sessionId,
      deviceId: device.deviceId,
      userId: device.userId,
      identityKey: device.curve25519,
      pickle: session.pickle(this.pickleKey),
      createdAt: now,
      lastReceivedAt: 0,
    };
  }

  encrypt(
    record: SessionRecord,
    plaintext: Uint8Array,
  ): { ciphertext: OlmCiphertext; session: SessionRecord } {
    const session = this.#load(record);
    const ciphertext = session.encrypt(plaintext);
    return { ciphertext, session: { ...record, pickle: session.pickle(this.pickleKey) } };
  }

  async decrypt(sender: RemoteDevice, message: OlmCiphertext, now: number): Promise<DecryptResult> {
    const sessions = (await this.#sessionsOf(sender)).sort(byActivity);
    if (message.type === 'prekey') {
      let sessionId: string;
      try {
        sessionId = this.crypto.prekeyMessageSessionId(message);
      } catch {
        return { ok: false, sessionId: undefined };
      }
      const existing = sessions.find((s) => s.sessionId === sessionId);
      if (existing) return this.#tryDecrypt(existing, message, now);
      try {
        const { session, plaintext } = this.account.createInboundSession(
          sender.curve25519,
          message,
        );
        this.#cache.get(sessionId)?.dispose();
        this.#cache.set(session.sessionId(), session);
        return {
          ok: true,
          plaintext,
          accountChanged: true,
          session: {
            sessionId: session.sessionId(),
            deviceId: sender.deviceId,
            userId: sender.userId,
            identityKey: sender.curve25519,
            pickle: session.pickle(this.pickleKey),
            createdAt: now,
            lastReceivedAt: now,
          },
        };
      } catch {
        return { ok: false, sessionId };
      }
    }
    for (const record of sessions) {
      const result = this.#tryDecrypt(record, message, now);
      if (result.ok) return result;
    }
    return { ok: false, sessionId: sessions[0]?.sessionId };
  }

  /**
   * Drops the cached object, so the next use restores the stored pickle. Call it when a batch
   * holding the session's new pickle failed to commit.
   */
  forget(sessionId: string): void {
    this.#cache.get(sessionId)?.dispose();
    this.#cache.delete(sessionId);
  }

  dispose(): void {
    for (const session of this.#cache.values()) session.dispose();
    this.#cache.clear();
  }

  #tryDecrypt(record: SessionRecord, message: OlmCiphertext, now: number): DecryptResult {
    try {
      // Inside the try: an unreadable pickle is a broken session like any other.
      const session = this.#load(record);
      const plaintext = session.decrypt(message);
      return {
        ok: true,
        plaintext,
        accountChanged: false,
        session: { ...record, pickle: session.pickle(this.pickleKey), lastReceivedAt: now },
      };
    } catch {
      // A failed decrypt must leave no trace: reload the stored state next time.
      this.forget(record.sessionId);
      return { ok: false, sessionId: record.sessionId };
    }
  }

  async #sessionsOf(device: RemoteDevice): Promise<SessionRecord[]> {
    // A device ID with other identity keys is another device: never reuse its sessions.
    return (await this.store.listSessions(device.deviceId)).filter(
      (s) => s.identityKey === device.curve25519,
    );
  }

  #load(record: SessionRecord): OlmSession {
    let session = this.#cache.get(record.sessionId);
    if (!session) {
      session = this.crypto.restoreSession(record.pickle, this.pickleKey);
      this.#cache.set(record.sessionId, session);
    }
    return session;
  }
}
