/**
 * The encrypted channel for ephemeral content (ADR 0021, 0028): an Olm session per device
 * pair, carried in EPHEMERAL packets that the server relays in memory to online devices only.
 * Nothing of it is stored anywhere but the advanced Olm session.
 *
 * - History sync uses it between this user's own devices (from the verified own directory),
 *   call signaling between the two call devices of a direct contact. Senders resolve through
 *   the verified directory; blocked users are dropped. Callers check which kind they accept.
 * - A device with no session yet gets one from a claimed one-time (or fallback) key, as in
 *   the outbox; that session then serves ordinary messages too.
 * - Incoming packets are handled one at a time, in arrival order.
 */
import {
  bytesToUuid,
  create,
  CryptoType,
  decodeContent,
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeSchema,
  PacketKind,
  PROTOCOL_VERSION,
  TransportPacketSchema,
  uuidToBytes,
  uuidv7,
  uuidv7Bytes,
  type Content,
  type ContentSchema,
  type MessageInitShape,
  type TransportPacket,
} from '@pingdost/protocol';
import type { SendResult } from '@pingdost/transport';

import { buildContent, checkHeader } from '../content';
import type { EngineCore } from '../core';
import { claimedKeySigned, errorCode } from '../directory';
import type { RemoteDevice } from '../sessions';
import type { DirectoryDeviceRecord } from '../store';

type Body = MessageInitShape<typeof ContentSchema>['body'];

/** An ephemeral packet is useless after this: the server drops it, and so do receivers. */
const PACKET_TTL_MS = 60_000;
/** `RATE_LIMITED` sends are tried again after 1 s, 2 s and 3 s. */
const RATE_LIMIT_RETRIES = 3;

export interface EphemeralContent {
  content: Content;
  sender: RemoteDevice & { device: DirectoryDeviceRecord };
}

/** From one of this user's own devices (history sync checks the sender is). */
export type OwnContent = EphemeralContent;

const UNSUPPORTED: SendResult = { ok: false, code: 'UNSUPPORTED', retryable: false };

export class EphemeralChannel {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly core: EngineCore,
    /** A packet that would not decrypt: the receiver's rate-limited session repair. */
    private readonly undecryptable: (sender: RemoteDevice, sessionId?: string) => Promise<void>,
  ) {}

  /** This user's other devices, as last verified. */
  async ownDevices(): Promise<DirectoryDeviceRecord[]> {
    const { core } = this;
    const lookup = await core.directoryFor(core.self.userId, core.settings.directoryMaxAgeMs);
    if (lookup.status !== 'ok') return [];
    return lookup.record.devices.filter((d) => d.deviceId !== core.self.deviceId);
  }

  /** Encrypts `body` for one own device and relays it. Never throws. */
  send(device: DirectoryDeviceRecord, body: Body): Promise<SendResult> {
    return this.sendTo(this.core.self.userId, device, body);
  }

  /**
   * Encrypts `body` for one device of `userId` (this user, or the direct contact the Content
   * is addressed to) and relays it with `flags`. Never throws.
   */
  async sendTo(
    userId: string,
    device: DirectoryDeviceRecord,
    body: Body,
    flags = 0,
  ): Promise<SendResult> {
    const { core } = this;
    const transport = core.options.transport;
    if (!transport.sendEphemeral) return UNSUPPORTED;
    if (transport.status$.value !== 'online') {
      return { ok: false, code: 'OFFLINE', retryable: true };
    }
    let packet: TransportPacket | undefined;
    try {
      const content = buildContent(
        {
          messageId: uuidv7(),
          conversationId: core.directConversationId(userId),
          senderUserId: core.self.userId,
          recipientUserId: userId,
          sentAt: core.now(),
        },
        body,
        core.settings.envelopeMaxBytes,
      );
      const remote: RemoteDevice = { ...device, userId };
      packet = await core.mutex.run(() => this.#encrypt(remote, content, flags));
      if (!packet) {
        const key = await this.#claim(device);
        if (!key) return { ok: false, code: 'NO_KEYS', retryable: true };
        packet = await core.mutex.run(() => this.#encrypt(remote, content, flags, key));
      }
    } catch (error) {
      core.log('warn', 'ephemeral content not sent', { code: errorCode(error) ?? 'error' });
      return { ok: false, code: 'INVALID', retryable: false };
    }
    if (!packet) return { ok: false, code: 'NO_KEYS', retryable: true };
    for (let attempt = 0; ; attempt++) {
      const result = await transport.sendEphemeral(packet);
      if (result.ok || result.code !== 'RATE_LIMITED' || attempt >= RATE_LIMIT_RETRIES) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }

  /** Queues an incoming packet; `handle` gets its checked content and authenticated sender. */
  receive(packet: TransportPacket, handle: (received: OwnContent) => Promise<void>): void {
    this.#queue = this.#queue
      .then(async () => {
        const received = await this.#open(packet);
        if (received) await handle(received);
      })
      .catch((error: unknown) => {
        this.core.log('warn', 'ephemeral packet failed', { error: String(error) });
      });
  }

  /** Resolves once every queued packet is handled. */
  idle(): Promise<void> {
    return this.#queue;
  }

  async #encrypt(
    remote: RemoteDevice,
    content: Uint8Array,
    flags: number,
    oneTimeKey?: string,
  ): Promise<TransportPacket | undefined> {
    const { core } = this;
    const now = core.now();
    let session = await core.sessions.preferred(remote);
    if (!session) {
      if (!oneTimeKey) return undefined;
      session = core.sessions.createOutbound(remote, oneTimeKey, now);
    }
    const encrypted = core.sessions.encrypt(session, content);
    await core.commit({ sessions: [encrypted.session] });
    const options = { envelopeMaxBytes: core.settings.envelopeMaxBytes, nowMs: now };
    const payload = encodeEnvelope(
      create(EnvelopeSchema, {
        envelopeId: uuidv7Bytes(),
        senderDeviceId: uuidToBytes(core.self.deviceId),
        recipientDeviceId: uuidToBytes(remote.deviceId),
        cryptoType: encrypted.ciphertext.type === 'prekey' ? CryptoType.OLM_PREKEY : CryptoType.OLM,
        ciphertext: encrypted.ciphertext.body,
      }),
      options,
    );
    return create(TransportPacketSchema, {
      version: PROTOCOL_VERSION,
      packetId: uuidv7Bytes(),
      kind: PacketKind.EPHEMERAL,
      dst: uuidToBytes(remote.deviceId),
      createdAtMs: BigInt(now),
      expiresAtMs: BigInt(now + PACKET_TTL_MS),
      hopBudget: 0,
      flags,
      payload,
    });
  }

  /** One signature-checked key to open a session with `device`. */
  async #claim(device: DirectoryDeviceRecord): Promise<string | undefined> {
    const { core } = this;
    try {
      const { keys } = await core.options.api.claim([device.deviceId]);
      const entry = keys.find((k) => k.deviceId === device.deviceId);
      if (entry && claimedKeySigned(core.options.crypto, device, entry)) return entry.key.publicKey;
      if (entry) core.log('warn', 'claimed key has a bad signature');
    } catch (error) {
      core.log('warn', 'key claim failed', { code: errorCode(error) ?? 'network' });
    }
    return undefined;
  }

  async #open(packet: TransportPacket): Promise<EphemeralContent | undefined> {
    const { core } = this;
    if (packet.kind !== PacketKind.EPHEMERAL) return undefined;
    let envelope;
    try {
      envelope = decodeEnvelope(packet.payload, {
        envelopeMaxBytes: core.settings.envelopeMaxBytes,
      });
    } catch {
      return undefined;
    }
    if (bytesToUuid(envelope.recipientDeviceId) !== core.self.deviceId) return undefined;
    if (envelope.cryptoType === CryptoType.MEGOLM) return undefined;
    const senderDeviceId = bytesToUuid(envelope.senderDeviceId);
    const owner = await core.ownerOf(senderDeviceId);
    if (owner.status !== 'ok') return undefined;
    if (owner.userId !== core.self.userId && core.isBlocked(owner.userId)) return undefined;
    const sender = {
      deviceId: senderDeviceId,
      userId: owner.userId,
      curve25519: owner.device.curve25519,
      device: owner.device,
    };
    const opened = await core.mutex.run(async () => {
      const now = core.now();
      const result = await core.sessions.decrypt(
        sender,
        {
          type: envelope.cryptoType === CryptoType.OLM_PREKEY ? 'prekey' : 'normal',
          body: envelope.ciphertext,
        },
        now,
      );
      if (!result.ok) return { failed: result.sessionId } as const;
      await core.commit({
        sessions: [result.session],
        ...(result.accountChanged ? { account: core.accountPickle() } : {}),
      });
      return { plaintext: result.plaintext } as const;
    });
    if ('failed' in opened) {
      await this.undecryptable(sender, opened.failed);
      return undefined;
    }
    let content: Content;
    try {
      content = decodeContent(opened.plaintext, {
        envelopeMaxBytes: core.settings.envelopeMaxBytes,
      });
    } catch {
      return undefined;
    }
    if (!content.header || !checkHeader(content.header, sender, core.self.userId)) return undefined;
    return { content, sender };
  }
}

/** History sync's name for it. */
export type OwnDeviceChannel = EphemeralChannel;
