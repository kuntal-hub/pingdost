/**
 * The Mongo delayed mailbox, `pending_envelopes` (REQ §16.3, ARCHITECTURE A3): temporary
 * delivery records, never chat history. `_id` is the envelope ID, so every write is
 * idempotent. A TTL index on `expiresAt` backs up the reaper.
 */
import { Binary, type Collection, type Db } from 'mongodb';

import type { EnvelopeRecord } from './record';
import type { IndexSetup } from '../../infra/mongo';

export interface PendingEnvelopeDoc {
  _id: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  /** The TransportPacket bytes (ciphertext only). */
  packet: Binary;
  createdAt: Date;
  /** When the envelope reached Mongo (migration, or a direct write while Redis was down). */
  stageChangedAt: Date;
  /** Absolute: the original createdAt + retention, never reset. */
  expiresAt: Date;
  deliveryState: 'pending';
}

/** What the mailbox needs from Mongo; tests swap in a failing one. */
export interface MongoMailboxStore {
  /** Idempotent: an existing document is left untouched (`$setOnInsert`, majority write). */
  insert(record: EnvelopeRecord, stageChangedAt: number): Promise<void>;
  /** Reads back after a write, to verify it before the Redis copy is dropped. */
  has(envelopeId: string): Promise<boolean>;
  /**
   * `insert` for a batch in one unordered bulk write (Phase 27): Atlas Free counts it as one
   * operation of its 100 per second, where one write per envelope capped the migration.
   */
  insertMany(records: readonly EnvelopeRecord[], stageChangedAt: number): Promise<void>;
  /** Which of `ids` are stored, in one read (the batch's verification). */
  existing(ids: readonly string[]): Promise<Set<string>>;
  /** The device's oldest unexpired envelopes. */
  list(deviceId: string, now: number, limit: number): Promise<EnvelopeRecord[]>;
  /** Deletes the device's envelopes among `ids`; returns how many. */
  remove(deviceId: string, ids: readonly string[]): Promise<number>;
  /** Deletes one envelope whatever its recipient (the migration's race cleanup). */
  removeOne(envelopeId: string): Promise<void>;
  removeExpired(now: number): Promise<number>;
  stats(now: number): Promise<{ count: number; oldestAgeSeconds: number }>;
}

export const PENDING_ENVELOPES = 'pending_envelopes';

export const pendingEnvelopeIndexes: IndexSetup = async (db) => {
  const collection = db.collection<PendingEnvelopeDoc>(PENDING_ENVELOPES);
  await collection.createIndex({ recipientDeviceId: 1, createdAt: 1 });
  // The oldest-item metric.
  await collection.createIndex({ createdAt: 1 });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
};

function toRecord(doc: PendingEnvelopeDoc): EnvelopeRecord {
  return {
    envelopeId: doc._id,
    senderDeviceId: doc.senderDeviceId,
    recipientDeviceId: doc.recipientDeviceId,
    packet: new Uint8Array(doc.packet.buffer.subarray(0, doc.packet.length())),
    createdAt: doc.createdAt.getTime(),
    expiresAt: doc.expiresAt.getTime(),
  };
}

/** Idempotent: an existing document is left untouched. */
function upsertOf(record: EnvelopeRecord, stageChangedAt: number) {
  return {
    $setOnInsert: {
      senderDeviceId: record.senderDeviceId,
      recipientDeviceId: record.recipientDeviceId,
      packet: new Binary(record.packet),
      createdAt: new Date(record.createdAt),
      stageChangedAt: new Date(stageChangedAt),
      expiresAt: new Date(record.expiresAt),
      deliveryState: 'pending' as const,
    },
  };
}

export class MongoMailbox implements MongoMailboxStore {
  readonly #docs: Collection<PendingEnvelopeDoc>;

  constructor(db: Db) {
    this.#docs = db.collection<PendingEnvelopeDoc>(PENDING_ENVELOPES, {
      writeConcern: { w: 'majority' },
      readConcern: { level: 'majority' },
    });
  }

  async insert(record: EnvelopeRecord, stageChangedAt: number): Promise<void> {
    await this.#docs.updateOne({ _id: record.envelopeId }, upsertOf(record, stageChangedAt), {
      upsert: true,
    });
  }

  async insertMany(records: readonly EnvelopeRecord[], stageChangedAt: number): Promise<void> {
    if (records.length === 0) return;
    await this.#docs.bulkWrite(
      records.map((record) => ({
        updateOne: {
          filter: { _id: record.envelopeId },
          update: upsertOf(record, stageChangedAt),
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async has(envelopeId: string): Promise<boolean> {
    return (await this.#docs.countDocuments({ _id: envelopeId }, { limit: 1 })) > 0;
  }

  async existing(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const docs = await this.#docs
      .find({ _id: { $in: [...ids] } }, { projection: { _id: 1 } })
      .toArray();
    return new Set(docs.map((doc) => doc._id));
  }

  async list(deviceId: string, now: number, limit: number): Promise<EnvelopeRecord[]> {
    const docs = await this.#docs
      .find({ recipientDeviceId: deviceId, expiresAt: { $gt: new Date(now) } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
    return docs.map(toRecord);
  }

  async remove(deviceId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.#docs.deleteMany({
      _id: { $in: [...ids] },
      recipientDeviceId: deviceId,
    });
    return result.deletedCount;
  }

  async removeOne(envelopeId: string): Promise<void> {
    await this.#docs.deleteOne({ _id: envelopeId });
  }

  async removeExpired(now: number): Promise<number> {
    const result = await this.#docs.deleteMany({ expiresAt: { $lte: new Date(now) } });
    return result.deletedCount;
  }

  async stats(now: number): Promise<{ count: number; oldestAgeSeconds: number }> {
    const [count, oldest] = await Promise.all([
      this.#docs.estimatedDocumentCount(),
      this.#docs.findOne({}, { sort: { createdAt: 1 }, projection: { createdAt: 1 } }),
    ]);
    const oldestAgeSeconds = oldest ? Math.max(0, (now - oldest.createdAt.getTime()) / 1000) : 0;
    return { count, oldestAgeSeconds };
  }
}
