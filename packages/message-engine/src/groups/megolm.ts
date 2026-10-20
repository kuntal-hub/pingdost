/**
 * Megolm sessions (ADR 0003, 0016). Like Olm sessions they live in the store as pickles and
 * are cached here; callers hold the engine lock and persist the returned records in the same
 * batch as whatever the operation produced.
 *
 * - One outbound session per group on this device, rotated on any member-set change, when a
 *   device it was shared with is no longer a recipient, after 100 messages or after 7 days.
 * - Each outbound session is also kept as an inbound copy, so a member device that lost its
 *   key can be sent an export from the index it needs (only devices it was shared with).
 * - Inbound sessions are bound to the device that shared them, and remember the indices
 *   they accepted: Megolm itself would decrypt a replay again.
 */
import type {
  CryptoProvider,
  MegolmInboundSession,
  MegolmOutboundSession,
} from '@pingdost/crypto/core';

import type { InboundGroupSessionRecord, OutboundGroupSessionRecord } from '../store';

export interface GroupSender {
  userId: string;
  deviceId: string;
  curve25519: string;
}

export type GroupDecryptResult =
  | { ok: true; plaintext: Uint8Array; messageIndex: number; record: InboundGroupSessionRecord }
  | { ok: false; reason: 'replay' | 'undecryptable' };

export interface RotationPolicy {
  maxMessages: number;
  maxAgeMs: number;
}

/** Whether `record` must be replaced before the next message. */
export function needsRotation(
  record: OutboundGroupSessionRecord | undefined,
  input: { now: number; memberKey: string; recipientDeviceIds: readonly string[] },
  policy: RotationPolicy,
): boolean {
  if (!record) return true;
  if (record.messageCount >= policy.maxMessages) return true;
  if (input.now - record.createdAt >= policy.maxAgeMs) return true;
  if (record.memberKey !== input.memberKey) return true;
  const current = new Set(input.recipientDeviceIds);
  return record.sharedWith.some((deviceId) => !current.has(deviceId));
}

export class GroupSessionManager {
  readonly #outbound = new Map<string, MegolmOutboundSession>();
  readonly #inbound = new Map<string, MegolmInboundSession>();

  constructor(
    private readonly crypto: CryptoProvider,
    private readonly pickleKey: Uint8Array,
  ) {}

  /** A new outbound session and its inbound copy (sender = this device). */
  create(
    groupId: string,
    self: GroupSender,
    memberKey: string,
    now: number,
  ): { outbound: OutboundGroupSessionRecord; own: InboundGroupSessionRecord } {
    const session = this.crypto.createOutboundGroupSession();
    const sessionId = session.sessionId();
    this.#outbound.set(sessionId, session);
    const inbound = this.crypto.createInboundGroupSession(session.sessionKey());
    const ownKey = `${self.deviceId}:${sessionId}`;
    this.#inbound.get(ownKey)?.dispose();
    this.#inbound.set(ownKey, inbound);
    return {
      outbound: {
        groupId,
        sessionId,
        pickle: session.pickle(this.pickleKey),
        createdAt: now,
        messageCount: 0,
        sharedWith: [],
        memberKey,
      },
      own: {
        sessionId,
        groupId,
        senderUserId: self.userId,
        senderDeviceId: self.deviceId,
        senderKey: self.curve25519,
        pickle: inbound.pickle(this.pickleKey),
        firstKnownIndex: inbound.firstKnownIndex(),
        seenIndices: [],
        createdAt: now,
        sharedAt: {},
      },
    };
  }

  /** The signed session key at the current index: the next message is the first readable. */
  sessionKey(record: OutboundGroupSessionRecord): string {
    return this.#loadOutbound(record).sessionKey();
  }

  encrypt(
    record: OutboundGroupSessionRecord,
    plaintext: Uint8Array,
  ): { ciphertext: Uint8Array; record: OutboundGroupSessionRecord } {
    const session = this.#loadOutbound(record);
    const ciphertext = session.encrypt(plaintext);
    return {
      ciphertext,
      record: {
        ...record,
        pickle: session.pickle(this.pickleKey),
        messageCount: record.messageCount + 1,
      },
    };
  }

  /**
   * An inbound session from a key that `sender` sent over Olm, or undefined when the key is
   * malformed or names another session.
   */
  receive(
    groupId: string,
    sender: GroupSender,
    sessionId: string,
    key: string,
    exported: boolean,
    now: number,
  ): InboundGroupSessionRecord | undefined {
    let session: MegolmInboundSession;
    try {
      session = exported
        ? this.crypto.importInboundGroupSession(key)
        : this.crypto.createInboundGroupSession(key);
    } catch {
      return undefined;
    }
    if (session.sessionId() !== sessionId) {
      session.dispose();
      return undefined;
    }
    const cacheKey = `${sender.deviceId}:${sessionId}`;
    this.#inbound.get(cacheKey)?.dispose();
    this.#inbound.set(cacheKey, session);
    return {
      sessionId,
      groupId,
      senderUserId: sender.userId,
      senderDeviceId: sender.deviceId,
      senderKey: sender.curve25519,
      pickle: session.pickle(this.pickleKey),
      firstKnownIndex: session.firstKnownIndex(),
      seenIndices: [],
      createdAt: now,
    };
  }

  /** Decrypts, rejecting an index this session already accepted. */
  decrypt(record: InboundGroupSessionRecord, ciphertext: Uint8Array): GroupDecryptResult {
    let result: { plaintext: Uint8Array; messageIndex: number };
    try {
      result = this.#loadInbound(record).decrypt(ciphertext);
    } catch {
      this.forget(record);
      return { ok: false, reason: 'undecryptable' };
    }
    if (record.seenIndices.includes(result.messageIndex)) return { ok: false, reason: 'replay' };
    return {
      ok: true,
      plaintext: result.plaintext,
      messageIndex: result.messageIndex,
      record: {
        ...record,
        seenIndices: [...record.seenIndices, result.messageIndex].sort((a, b) => a - b),
      },
    };
  }

  /** The session exported from `index` (or its first known index, if later). */
  exportFrom(record: InboundGroupSessionRecord, index: number): string | undefined {
    return this.#loadInbound(record).exportAt(Math.max(index, record.firstKnownIndex));
  }

  /** Drops cached objects so the next use restores the stored pickles (failed commit). */
  forget(record: { sessionId: string; senderDeviceId?: string }): void {
    const outbound = this.#outbound.get(record.sessionId);
    outbound?.dispose();
    this.#outbound.delete(record.sessionId);
    if (record.senderDeviceId) {
      const key = `${record.senderDeviceId}:${record.sessionId}`;
      this.#inbound.get(key)?.dispose();
      this.#inbound.delete(key);
    }
  }

  dispose(): void {
    for (const session of this.#outbound.values()) session.dispose();
    for (const session of this.#inbound.values()) session.dispose();
    this.#outbound.clear();
    this.#inbound.clear();
  }

  #loadOutbound(record: OutboundGroupSessionRecord): MegolmOutboundSession {
    let session = this.#outbound.get(record.sessionId);
    if (!session) {
      session = this.crypto.restoreOutboundGroupSession(record.pickle, this.pickleKey);
      this.#outbound.set(record.sessionId, session);
    }
    return session;
  }

  #loadInbound(record: InboundGroupSessionRecord): MegolmInboundSession {
    const key = `${record.senderDeviceId}:${record.sessionId}`;
    let session = this.#inbound.get(key);
    if (!session) {
      session = this.crypto.restoreInboundGroupSession(record.pickle, this.pickleKey);
      this.#inbound.set(key, session);
    }
    return session;
  }
}
