/**
 * The delivery mailbox (REQ §9, ARCHITECTURE A3). The sender's outbox stays the durable copy
 * until `Accepted`, which needs the recipient's transport ACK, a Redis write or a Mongo
 * write; the server never holds the only copy in memory. Envelopes are deduped on their ID,
 * and expiry is absolute from the server's receive time.
 */
import type { Logger } from 'pino';

import {
  bytesEqual,
  bytesToUuid,
  CryptoType,
  decodeEnvelope,
  encodeTransportPacket,
  ProtocolError,
  type TransportPacket,
} from '@pingdost/protocol';
import type { ErrorCode } from '@pingdost/shared-types';

import type { MongoMailboxStore } from './mongo-store';
import type { EnvelopeRecord } from './record';
import type { RedisMailbox } from './redis-store';
import type { MailboxSettings } from './settings';
import type { Clock } from '../../infra/clock';
import type { Metrics } from '../../infra/metrics';

/** A send the gateway answers with `ServerError{code}`. */
export class DeliveryError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** The WS error code for a codec rejection. */
export function protocolErrorCode(error: ProtocolError): ErrorCode {
  switch (error.code) {
    case 'OVERSIZED':
      return 'ENVELOPE_TOO_LARGE';
    case 'EXPIRED':
      return 'ENVELOPE_EXPIRED';
    case 'UNSUPPORTED_VERSION':
      return 'PROTOCOL_VERSION_UNSUPPORTED';
    default:
      return 'MALFORMED_FRAME';
  }
}

/** Where a pending envelope was found; an ACK deletes it from there. */
export type EnvelopeSource = 'redis' | 'mongo' | 'both';

export interface PendingEnvelope extends EnvelopeRecord {
  source: EnvelopeSource;
}

/** `redis`/`mongo`: newly stored there; `duplicate`: the mailbox already held the ID. */
export type StoreOutcome = 'redis' | 'mongo' | 'duplicate';

export interface DeliveryDeps {
  settings: MailboxSettings;
  clock: Clock;
  metrics: Metrics;
  log: Logger;
  redis: RedisMailbox;
  mongo: MongoMailboxStore;
  /** The user owning the device, if it exists and is active. */
  activeDeviceOwner(deviceId: string): Promise<string | undefined>;
  /** Whether `blockerUserId` blocked `userId` (ADR 0014). */
  isBlocked?(blockerUserId: string, userId: string): Promise<boolean>;
  /** Whether `userId` is a current member of the group (ADR 0016). */
  isGroupMember?(groupId: string, userId: string): Promise<boolean>;
}

/** A checked `Send`. `blocked`: the recipient blocked the sender, so it must go nowhere. */
export interface PreparedEnvelope {
  record: EnvelopeRecord;
  blocked: boolean;
}

export class DeliveryService {
  constructor(private readonly d: DeliveryDeps) {}

  /**
   * Checks a `Send` from the socket of `sender` and builds the record to deliver.
   * `decodeClientFrame` has already checked the packet (kind, size, version, expiry).
   */
  async prepare(
    sender: { userId: string; deviceId: string },
    packet: TransportPacket,
  ): Promise<PreparedEnvelope> {
    const senderDeviceId = sender.deviceId;
    const { settings, clock } = this.d;
    const now = clock.now();
    let envelopeId: string;
    let recipientDeviceId: string;
    let groupId: string | undefined;
    try {
      const envelope = decodeEnvelope(packet.payload, {
        envelopeMaxBytes: settings.envelopeMaxBytes,
      });
      if (!bytesEqual(packet.dst, envelope.recipientDeviceId)) {
        throw new DeliveryError('MALFORMED_FRAME', 'dst is not the envelope recipient');
      }
      if (bytesToUuid(envelope.senderDeviceId) !== senderDeviceId) {
        throw new DeliveryError('FORBIDDEN', 'sender_device_id is not this device');
      }
      if (envelope.cryptoType === CryptoType.MEGOLM && !envelope.groupId) {
        throw new DeliveryError('MALFORMED_FRAME', 'a Megolm envelope needs its group');
      }
      envelopeId = bytesToUuid(envelope.envelopeId);
      recipientDeviceId = bytesToUuid(envelope.recipientDeviceId);
      groupId = envelope.groupId ? bytesToUuid(envelope.groupId) : undefined;
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw new DeliveryError(protocolErrorCode(error), 'invalid envelope');
      }
      throw error;
    }
    const recipientUserId = await this.d.activeDeviceOwner(recipientDeviceId);
    if (recipientUserId === undefined) {
      throw new DeliveryError('RECIPIENT_UNKNOWN', 'no such active device');
    }
    // Group traffic (Megolm messages, room keys) flows only between current members, so a
    // removed member gets no new keys or messages (REQ §8.2, ADR 0016).
    if (groupId !== undefined) {
      const allowed =
        ((await this.d.isGroupMember?.(groupId, sender.userId)) ?? false) &&
        ((await this.d.isGroupMember?.(groupId, recipientUserId)) ?? false);
      if (!allowed) throw new DeliveryError('NOT_A_MEMBER', 'not a current group member');
    }
    const blocked =
      recipientUserId !== sender.userId &&
      ((await this.d.isBlocked?.(recipientUserId, sender.userId)) ?? false);
    return {
      blocked,
      record: {
        envelopeId,
        senderDeviceId,
        recipientDeviceId,
        packet: encodeTransportPacket(packet, {
          envelopeMaxBytes: settings.envelopeMaxBytes,
          nowMs: now,
        }),
        createdAt: now,
        // The server sets expiry from its own receive time and never extends the sender's.
        expiresAt: Math.min(Number(packet.expiresAtMs), now + settings.retentionMs),
      },
    };
  }

  /**
   * The offline path: Redis, or Mongo when Redis fails. Throws `MAILBOX_UNAVAILABLE` (the
   * sender keeps the envelope in its outbox and retries) when neither store takes it.
   */
  async store(record: EnvelopeRecord): Promise<StoreOutcome> {
    const { settings, metrics, log, redis, mongo } = this.d;
    const now = this.d.clock.now();
    let mongoUp = true;
    try {
      // A retransmit after migration: Mongo already holds the one copy.
      if (await mongo.has(record.envelopeId)) return this.#duplicate();
    } catch (error) {
      mongoUp = false;
      log.warn({ err: error }, 'mailbox: mongo check failed');
    }

    const dueAt = Math.min(record.createdAt + settings.stageMs, record.expiresAt);
    try {
      const fresh = await redis.store(record, dueAt, Math.max(1, dueAt - now) + settings.graceMs);
      if (!fresh) return this.#duplicate();
      metrics.envelopesAccepted.inc({ path: 'redis' });
      return 'redis';
    } catch (error) {
      log.warn({ err: error }, 'mailbox: redis store failed, writing to mongo');
    }
    if (mongoUp) {
      try {
        await mongo.insert(record, now);
        metrics.envelopesAccepted.inc({ path: 'mongo' });
        return 'mongo';
      } catch (error) {
        log.error({ err: error }, 'mailbox: mongo store failed');
      }
    }
    throw new DeliveryError('MAILBOX_UNAVAILABLE', 'the mailbox is unavailable');
  }

  #duplicate(): StoreOutcome {
    this.d.metrics.envelopeDuplicates.inc();
    return 'duplicate';
  }

  /** The device's unexpired envelopes from both stores: deduped, oldest first. */
  async pending(deviceId: string, limit: number): Promise<PendingEnvelope[]> {
    const { redis, mongo, log } = this.d;
    const now = this.d.clock.now();
    const [staged, delayed] = await Promise.allSettled([
      redis.list(deviceId, limit),
      mongo.list(deviceId, now, limit),
    ]);
    if (staged.status === 'rejected' && delayed.status === 'rejected') {
      throw new DeliveryError('MAILBOX_UNAVAILABLE', 'the mailbox is unavailable');
    }
    if (staged.status === 'rejected')
      log.warn({ err: staged.reason }, 'mailbox: redis fetch failed');
    if (delayed.status === 'rejected') {
      log.warn({ err: delayed.reason }, 'mailbox: mongo fetch failed');
    }

    const merged = new Map<string, PendingEnvelope>();
    for (const record of staged.status === 'fulfilled' ? staged.value.records : []) {
      merged.set(record.envelopeId, { ...record, source: 'redis' });
    }
    for (const record of delayed.status === 'fulfilled' ? delayed.value : []) {
      const known = merged.get(record.envelopeId);
      merged.set(
        record.envelopeId,
        known ? { ...known, source: 'both' } : { ...record, source: 'mongo' },
      );
    }
    return [...merged.values()]
      .filter((envelope) => envelope.expiresAt > now)
      .sort((a, b) => a.createdAt - b.createdAt || a.envelopeId.localeCompare(b.envelopeId))
      .slice(0, limit);
  }

  /**
   * An ACK from the recipient device: deletes its envelopes from the stores that hold them.
   * Idempotent; unknown IDs are a no-op. A failed delete only means a later redelivery,
   * which the client dedupes.
   */
  async ack(deviceId: string, byStore: { redis: string[]; mongo: string[] }): Promise<void> {
    const { redis, mongo, metrics, log } = this.d;
    metrics.envelopesAcked.inc(new Set([...byStore.redis, ...byStore.mongo]).size);
    await Promise.all([
      redis.remove(deviceId, byStore.redis).catch((error: unknown) => {
        metrics.deletionFailures.inc({ store: 'redis' });
        log.warn({ err: error }, 'mailbox: redis ack delete failed');
      }),
      mongo.remove(deviceId, byStore.mongo).catch((error: unknown) => {
        metrics.deletionFailures.inc({ store: 'mongo' });
        log.warn({ err: error }, 'mailbox: mongo ack delete failed');
      }),
    ]);
  }
}
