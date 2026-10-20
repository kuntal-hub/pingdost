/**
 * Attachment staging (REQ §10.2, §16.4; ADR 0017). The server holds ciphertext only, for a
 * short time, and knows sizes, a hash, the uploading device and the devices that may fetch it:
 * never a key, a name or a type.
 * - `create` checks the size (≤ 100 MB of plaintext plus tags), the uploader's quota and the
 *   recipient devices, and returns signed part URLs. Expiry is the earlier of the retention cap
 *   and the linked message's expiry.
 * - `complete` joins the parts and checks size and SHA-256 before anyone can download.
 * - A recipient device's `ack` removes it from the list; once every recipient acknowledged,
 *   the object is deleted. The janitor deletes whatever expired, uploads never completed, and
 *   store leftovers no record claims.
 */
import type { Collection, Db } from 'mongodb';
import type { Logger } from 'pino';

import {
  CIPHERTEXT_CHUNK_SIZE,
  ciphertextSizeFor,
  PART_CHUNKS,
  partCountFor,
  S3_PART_CHUNKS,
} from '@pingdost/attachments';
import type {
  AttachmentStatus,
  AttachmentStatusResponse,
  CreateAttachmentRequest,
  CreateAttachmentResponse,
  DownloadUrlResponse,
} from '@pingdost/shared-types';

import type { AttachmentStore } from './store/types';
import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';
import type { Metrics } from '../../infra/metrics';
import type { IndexSetup } from '../../infra/mongo';
import type { DeviceCollections } from '../device/repo';

export interface AttachmentDoc {
  /** The attachment ID (client UUIDv7, also in the E2EE manifest). */
  _id: string;
  uploaderUserId: string;
  uploaderDeviceId: string;
  ciphertextBytes: number;
  /** SHA-256 of the whole ciphertext, as the uploader declared it (unpadded base64). */
  sha256: string;
  partSize: number;
  partCount: number;
  /** The store's multipart upload (s3). */
  uploadId: string | null;
  pendingRecipientDeviceIds: string[];
  ackedDeviceIds: string[];
  status: AttachmentStatus;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date;
}

export const attachmentIndexes: IndexSetup = async (db) => {
  const attachments = db.collection<AttachmentDoc>('attachments');
  await attachments.createIndex({ uploaderUserId: 1, status: 1 });
  await attachments.createIndex({ expiresAt: 1 });
  await attachments.createIndex({ status: 1, createdAt: 1 });
};

export interface AttachmentSettings {
  maxPlaintextBytes: number;
  retentionMs: number;
  urlTtlMs: number;
  userQuotaBytes: number;
  /** All users together. */
  totalQuotaBytes: number;
  orphanMs: number;
}

export interface AuthDevice {
  userId: string;
  deviceId: string;
}

export type JanitorReason = 'acked' | 'expired' | 'orphaned' | 'leftover';

/** Unpadded base64 of a digest, as the uploader sends it. */
const toB64 = (digest: Buffer) => digest.toString('base64').replace(/=+$/, '');

export class AttachmentService {
  readonly #docs: Collection<AttachmentDoc>;
  readonly partSize: number;

  constructor(
    private readonly d: {
      db: Db;
      store: AttachmentStore;
      devices: DeviceCollections['devices'];
      settings: AttachmentSettings;
      clock: Clock;
      metrics: Metrics;
      log: Logger;
    },
  ) {
    this.#docs = d.db.collection<AttachmentDoc>('attachments');
    // S3 refuses multipart parts under 5 MiB (except the last).
    this.partSize = (d.store.kind === 's3' ? S3_PART_CHUNKS : PART_CHUNKS) * CIPHERTEXT_CHUNK_SIZE;
  }

  get store(): AttachmentStore {
    return this.d.store;
  }

  async create(
    auth: AuthDevice,
    request: CreateAttachmentRequest,
  ): Promise<CreateAttachmentResponse> {
    const { settings, clock } = this.d;
    const now = clock.now();
    if (request.ciphertextBytes > ciphertextSizeFor(settings.maxPlaintextBytes)) {
      throw new AppError('ATTACHMENT_TOO_LARGE');
    }
    if (Buffer.from(request.ciphertextSha256, 'base64').length !== 32) {
      throw new AppError('VALIDATION_FAILED', { detail: 'ciphertextSha256 must be a SHA-256.' });
    }
    const recipients = [...new Set(request.recipientDeviceIds)];
    const active = await this.d.devices.countDocuments({
      _id: { $in: recipients },
      status: 'active',
    });
    if (active !== recipients.length) throw new AppError('RECIPIENT_UNKNOWN');
    if ((await this.stagedBytes(auth.userId)) + request.ciphertextBytes > settings.userQuotaBytes) {
      throw new AppError('ATTACHMENT_QUOTA_EXCEEDED');
    }
    // The VPS disk is shared with everything else: staging never takes all of it.
    if ((await this.stagedBytes()) + request.ciphertextBytes > settings.totalQuotaBytes) {
      this.d.log.warn('attachment staging is full');
      throw new AppError('ATTACHMENT_STAGING_FULL');
    }
    const expiresAt = Math.min(now + settings.retentionMs, request.expiresAt ?? Infinity);
    if (expiresAt <= now) throw new AppError('ATTACHMENT_EXPIRED');

    const partCount = partCountFor(request.ciphertextBytes, this.partSize);
    const doc: AttachmentDoc = {
      _id: request.attachmentId,
      uploaderUserId: auth.userId,
      uploaderDeviceId: auth.deviceId,
      ciphertextBytes: request.ciphertextBytes,
      sha256: request.ciphertextSha256,
      partSize: this.partSize,
      partCount,
      uploadId: null,
      pendingRecipientDeviceIds: recipients,
      ackedDeviceIds: [],
      status: 'uploading',
      createdAt: new Date(now),
      completedAt: null,
      expiresAt: new Date(expiresAt),
    };
    try {
      await this.#docs.insertOne(doc);
    } catch (error) {
      // An earlier attempt created it: the uploader resumes with `status`.
      if ((error as { code?: number }).code === 11_000) throw new AppError('CONFLICT');
      throw error;
    }
    let uploadId: string | undefined;
    try {
      uploadId = await this.d.store.begin(doc._id);
    } catch (error) {
      await this.#docs.deleteOne({ _id: doc._id });
      this.d.log.warn({ err: error }, 'attachment store unavailable');
      throw new AppError('UNAVAILABLE');
    }
    if (uploadId) await this.#docs.updateOne({ _id: doc._id }, { $set: { uploadId } });
    const urlsExpireAt = now + settings.urlTtlMs;
    return {
      attachmentId: doc._id,
      partSize: this.partSize,
      partCount,
      uploadUrls: await this.#urls(doc._id, uploadId, [], partCount, urlsExpireAt),
      urlsExpireAt,
      expiresAt,
    };
  }

  /** The uploader's view: which parts arrived, fresh URLs for the rest. */
  async status(auth: AuthDevice, id: string): Promise<AttachmentStatusResponse> {
    const doc = await this.#uploaderDoc(auth, id);
    return this.#status(doc);
  }

  async #status(doc: AttachmentDoc): Promise<AttachmentStatusResponse> {
    const now = this.d.clock.now();
    const urlsExpireAt = now + this.d.settings.urlTtlMs;
    const received =
      doc.status === 'uploading'
        ? (await this.d.store.listParts(doc._id, doc.uploadId ?? undefined))
            .filter((p) => p.index < doc.partCount && p.size === this.#partLength(doc, p.index))
            .map((p) => p.index)
        : Array.from({ length: doc.partCount }, (_, i) => i);
    return {
      attachmentId: doc._id,
      status: doc.status,
      partSize: doc.partSize,
      partCount: doc.partCount,
      receivedParts: received,
      uploadUrls:
        doc.status === 'uploading'
          ? await this.#urls(
              doc._id,
              doc.uploadId ?? undefined,
              received,
              doc.partCount,
              urlsExpireAt,
            )
          : [],
      urlsExpireAt,
      expiresAt: doc.expiresAt.getTime(),
    };
  }

  /** The expected byte length of part `index`. */
  #partLength(doc: AttachmentDoc, index: number): number {
    return Math.min(doc.partSize, doc.ciphertextBytes - index * doc.partSize);
  }

  /** Checks a part arriving at a signed `fs` URL, before it is written. */
  async acceptPart(id: string, index: number, length: number): Promise<void> {
    const doc = await this.#docs.findOne({ _id: id });
    if (!doc || doc.status !== 'uploading') throw new AppError('ATTACHMENT_NOT_FOUND');
    if (doc.expiresAt.getTime() <= this.d.clock.now()) throw new AppError('ATTACHMENT_EXPIRED');
    if (index >= doc.partCount || length !== this.#partLength(doc, index)) {
      throw new AppError('VALIDATION_FAILED', { detail: 'Wrong part number or size.' });
    }
  }

  async complete(auth: AuthDevice, id: string): Promise<AttachmentStatusResponse> {
    const doc = await this.#uploaderDoc(auth, id);
    if (doc.status !== 'uploading') return this.#status(doc);
    const status = await this.#status(doc);
    if (status.receivedParts.length !== doc.partCount) return status; // still missing parts
    const joined = await this.d.store.complete(id, doc.uploadId ?? undefined, doc.partCount);
    if (joined.size !== doc.ciphertextBytes || toB64(joined.sha256) !== doc.sha256) {
      // Not what was announced: nobody may download it.
      await this.#delete(doc, 'orphaned');
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The uploaded ciphertext does not match its size or SHA-256.',
      });
    }
    const done = await this.#docs.findOneAndUpdate(
      { _id: id, status: 'uploading' },
      { $set: { status: 'ready', completedAt: new Date(this.d.clock.now()) } },
      { returnDocument: 'after' },
    );
    return this.#status(done ?? { ...doc, status: 'ready' });
  }

  /** A recipient device's short-lived download URL. */
  async downloadUrl(auth: AuthDevice, id: string): Promise<DownloadUrlResponse> {
    const doc = await this.#readyFor(auth, id);
    const expiresAt = Math.min(
      this.d.clock.now() + this.d.settings.urlTtlMs,
      doc.expiresAt.getTime(),
    );
    return {
      url: await this.d.store.downloadUrl(id, auth.deviceId, expiresAt),
      expiresAt,
      ciphertextBytes: doc.ciphertextBytes,
    };
  }

  /** Checks a download at a signed `fs` URL (the device must still be a recipient). */
  async acceptDownload(id: string, deviceId: string): Promise<AttachmentDoc> {
    return this.#readyFor({ userId: '', deviceId }, id);
  }

  /** A recipient device has the file; the last one's acknowledgement deletes it. */
  async ack(auth: AuthDevice, id: string): Promise<void> {
    const doc = await this.#docs.findOneAndUpdate(
      { _id: id, pendingRecipientDeviceIds: auth.deviceId },
      { $addToSet: { ackedDeviceIds: auth.deviceId } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new AppError('ATTACHMENT_NOT_FOUND');
    const acked = new Set(doc.ackedDeviceIds);
    if (doc.status !== 'ready' || !doc.pendingRecipientDeviceIds.every((d) => acked.has(d))) return;
    const claimed = await this.#docs.findOneAndUpdate(
      { _id: id, status: 'ready' },
      { $set: { status: 'deleting' } },
      { returnDocument: 'after' },
    );
    if (claimed) await this.#delete(claimed, 'acked').catch(() => undefined);
  }

  /** Ciphertext staged for `userId` (uploading or ready): the quota's measure. */
  async stagedBytes(userId?: string): Promise<number> {
    const [row] = await this.#docs
      .aggregate<{ total: number }>([
        {
          $match: {
            ...(userId ? { uploaderUserId: userId } : {}),
            status: { $in: ['uploading', 'ready'] },
          },
        },
        { $group: { _id: null, total: { $sum: '$ciphertextBytes' } } },
      ])
      .toArray();
    return row?.total ?? 0;
  }

  /** For `/metrics`: staged bytes, objects and the oldest one's age. */
  async stats(): Promise<{ bytes: number; count: number; oldestAgeSeconds: number }> {
    const oldest = await this.#docs.findOne(
      {},
      { sort: { createdAt: 1 }, projection: { createdAt: 1 } },
    );
    return {
      bytes: await this.stagedBytes(),
      count: await this.#docs.countDocuments(),
      oldestAgeSeconds: oldest
        ? Math.max(0, Math.floor((this.d.clock.now() - oldest.createdAt.getTime()) / 1_000))
        : 0,
    };
  }

  /**
   * One janitor pass: expired objects, uploads never completed, deletions that failed earlier,
   * then store leftovers no record claims. Returns the deletions by reason.
   */
  async janitor(limit = 500): Promise<Record<JanitorReason, number>> {
    const now = this.d.clock.now();
    const counts: Record<JanitorReason, number> = {
      acked: 0,
      expired: 0,
      orphaned: 0,
      leftover: 0,
    };
    const sweep = async (filter: object, reason: JanitorReason) => {
      for (const doc of await this.#docs.find(filter).limit(limit).toArray()) {
        try {
          await this.#delete(doc, reason);
          counts[reason]++;
        } catch {
          // Counted as a failure; retried next pass.
        }
      }
    };
    await sweep({ expiresAt: { $lte: new Date(now) } }, 'expired');
    await sweep(
      { status: 'uploading', createdAt: { $lte: new Date(now - this.d.settings.orphanMs) } },
      'orphaned',
    );
    await sweep({ status: 'deleting' }, 'acked');
    try {
      counts.leftover = await this.d.store.sweep(
        now - this.d.settings.orphanMs,
        async (id) => (await this.#docs.countDocuments({ _id: id }, { limit: 1 })) > 0,
      );
      this.d.metrics.attachmentsDeleted.inc({ reason: 'leftover' }, counts.leftover);
    } catch (error) {
      this.d.metrics.attachmentDeletionFailures.inc();
      this.d.log.warn({ err: error }, 'attachment store sweep failed');
    }
    return counts;
  }

  async #delete(doc: AttachmentDoc, reason: JanitorReason): Promise<void> {
    try {
      await this.d.store.delete(doc._id, doc.uploadId ?? undefined);
    } catch (error) {
      this.d.metrics.attachmentDeletionFailures.inc();
      this.d.log.warn({ err: error, reason }, 'staged attachment delete failed');
      await this.#docs.updateOne({ _id: doc._id }, { $set: { status: 'deleting' } });
      throw error;
    }
    await this.#docs.deleteOne({ _id: doc._id });
    this.d.metrics.attachmentsDeleted.inc({ reason });
  }

  async #uploaderDoc(auth: AuthDevice, id: string): Promise<AttachmentDoc> {
    const doc = await this.#docs.findOne({ _id: id });
    if (doc?.uploaderDeviceId !== auth.deviceId) throw new AppError('ATTACHMENT_NOT_FOUND');
    return doc;
  }

  /** A ready, unexpired attachment that `auth`'s device may download. */
  async #readyFor(auth: AuthDevice, id: string): Promise<AttachmentDoc> {
    const doc = await this.#docs.findOne({ _id: id });
    // Not a recipient: the same answer as for no attachment at all.
    if (!doc?.pendingRecipientDeviceIds.includes(auth.deviceId)) {
      throw new AppError('ATTACHMENT_NOT_FOUND');
    }
    if (doc.expiresAt.getTime() <= this.d.clock.now()) throw new AppError('ATTACHMENT_EXPIRED');
    if (doc.status !== 'ready') throw new AppError('ATTACHMENT_NOT_FOUND');
    return doc;
  }

  async #urls(
    id: string,
    uploadId: string | undefined,
    received: number[],
    partCount: number,
    expiresAt: number,
  ) {
    const have = new Set(received);
    const urls: { index: number; url: string }[] = [];
    for (let index = 0; index < partCount; index++) {
      if (have.has(index)) continue;
      urls.push({ index, url: await this.d.store.uploadUrl(id, uploadId, index, expiresAt) });
    }
    return urls;
  }
}
