// Attachment transfers, run in the leader tab only (ADR 0021): the web's counterpart of the
// phone's runner (`apps/mobile/src/attachments/transfers.ts`).
// - Download: the staged copy when this browser is one of its recipients (signed URL, Range
//   resume); otherwise the phone's own copy over the E2EE ephemeral relay, in parts, up to the
//   limit set in Settings (default 25 MB). Either way the ciphertext goes into the cache and is
//   checked completely (every chunk, then the whole-file hash) before it is used, and only
//   then is the staged copy acknowledged.
// - Send: images are compressed on a canvas unless sent as the original; video is never
//   compressed here (over the limit it is refused, with the reason). The file and its preview
//   are encrypted into the cache, the message is stored held, both are uploaded for the
//   recipients fixed at the first attempt, and only then is the message released. An upload
//   cut off by a closed tab resumes when PingDost starts again.
import { api } from '@/session/session';
import {
  AttachmentError,
  buildManifest,
  canSend,
  ciphertextSizeFor,
  compressByDefault,
  decryptStream,
  downloadCiphertext,
  encryptStream,
  formatSize,
  IMAGE_PRESETS,
  SNIFF_BYTES,
  sniffMime,
  uploadAttachment,
  verifyStream,
  type EncryptedAttachment,
  type ImageQuality,
  type MediaDetails,
} from '@pingdost/attachments';
import { BYTES_PER_MB, DEFAULT_LIMITS } from '@pingdost/config/public';
import type { CryptoProvider } from '@pingdost/crypto/core';
import {
  attachmentDecryptInput,
  FILE_PART_BYTES,
  SyncError,
  type AttachmentInfo,
  type MessageEngine,
  type MessageRecord,
} from '@pingdost/message-engine';
import { fromBase64, uuidv7 } from '@pingdost/protocol';
import { database, SealedRecords, vaultKey } from '@pingdost/web-store';

import { cacheLimitMb, fileCache, phoneFileLimitMb } from './cache';
import { compressImage, imageSize, imageThumbnail, mediaInfo, type EncodedImage } from './media';

export type TransferError =
  /** Over the size this browser fetches from the phone. */
  | 'too_large'
  /** The phone has no copy (never downloaded there, or deleted). */
  | 'missing'
  | 'phone_offline'
  | 'offline'
  | 'no_phone'
  | 'integrity'
  | 'network'
  | 'failed';

export interface TransferStatus {
  attachmentId: string;
  messageId: string;
  direction: 'down' | 'up';
  phase: 'running' | 'done' | 'failed';
  done: number;
  total: number;
  source: 'server' | 'phone' | null;
  error: TransferError | null;
}

export interface SendFileOptions {
  caption: string;
  /** Send an image as it is, without compressing it. */
  original: boolean;
  quality: ImageQuality;
  replyTo?: string;
  /** Forwarded from someone else's message (Phase 39, ADR 0043). */
  forwarded?: boolean;
}

/** Why a file cannot be sent; the message is for the user. */
export class SendFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendFileError';
  }
}

class TransferFailure extends Error {
  constructor(readonly code: TransferError) {
    super(code);
  }
}

interface PendingUpload {
  messageId: string;
  /** Preview first, then the file. */
  attachmentIds: string[];
  /** The devices staged for, fixed at the first attempt. */
  recipients: string[] | null;
}

const PENDING = 'pending-uploads';
/** File parts asked of the phone at once. */
const PHONE_WINDOW = 4;
const READ_BYTES = 1_048_576;

function errorOf(error: unknown): TransferError {
  if (error instanceof TransferFailure) return error.code;
  if (error instanceof SyncError) {
    return error.code === 'timeout' || error.code === 'busy' ? 'phone_offline' : error.code;
  }
  if (error instanceof AttachmentError) {
    return error.code === 'integrity'
      ? 'integrity'
      : error.code === 'network'
        ? 'network'
        : 'failed';
  }
  const { kind } = (error ?? {}) as { kind?: string };
  return kind === 'network' || kind === 'timeout' ? 'offline' : 'failed';
}

async function* blobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += READ_BYTES) {
    yield new Uint8Array(await blob.slice(offset, offset + READ_BYTES).arrayBuffer());
  }
}

export class Transfers {
  readonly #status = new Map<string, TransferStatus>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #uploading = new Set<string>();
  #records: Promise<SealedRecords> | undefined;

  constructor(
    private readonly engine: MessageEngine,
    private readonly provider: CryptoProvider,
    private readonly announce: (status: TransferStatus) => void,
  ) {}

  snapshot(): TransferStatus[] {
    return [...this.#status.values()];
  }

  // Downloads

  /** Fetches a message's file (or its preview) into the cache, unless it is there already. */
  download(messageId: string, role: 'file' | 'thumbnail' = 'file'): Promise<void> {
    return this.engine.getMessage(messageId).then((message) => {
      const info = role === 'thumbnail' ? message?.attachment?.thumbnail : message?.attachment;
      if (!message || !info) return;
      const id = info.attachmentId;
      const running = this.#running.get(id);
      if (running) return running;
      const job = this.#download(message, info).finally(() => this.#running.delete(id));
      this.#running.set(id, job);
      return job;
    });
  }

  async #download(message: MessageRecord, info: AttachmentInfo): Promise<void> {
    const cache = fileCache();
    const id = info.attachmentId;
    const total = info.ciphertextSize;
    const status: TransferStatus = {
      attachmentId: id,
      messageId: message.messageId,
      direction: 'down',
      phase: 'running',
      done: 0,
      total,
      source: null,
      error: null,
    };
    if (await cache.isComplete(id)) {
      this.#set({ ...status, phase: 'done', done: total });
      return;
    }
    this.#set(status);
    try {
      const writer = await cache.writer(id, total);
      let source: 'server' | 'phone' = 'server';
      try {
        await downloadCiphertext({
          api: api.attachments,
          attachmentId: id,
          ciphertextSize: total,
          savedBytes: writer.stored,
          write: (chunk) => writer.append(chunk),
          reset: () => writer.reset(),
          onProgress: (done) => this.#set({ ...status, done, source: 'server' }),
        });
        await writer.flush();
      } catch (error) {
        // Not staged for this browser (sent before it was linked), or gone: the phone's copy.
        if (!(error instanceof AttachmentError) || error.code !== 'gone') throw error;
        source = 'phone';
        if (total > phoneFileLimitMb() * BYTES_PER_MB) throw new TransferFailure('too_large');
        // The phone keeps the same ciphertext as staging, so stored bytes stay valid.
        await this.#fromPhone(id, total, writer, (done) =>
          this.#set({ ...status, done, source: 'phone' }),
        );
      }
      try {
        await verifyStream(this.provider, attachmentDecryptInput(info), cache.read(id));
      } catch {
        await cache.delete([id]);
        throw new TransferFailure('integrity');
      }
      await writer.complete();
      if (source === 'server') void api.attachments.ack(id).catch(() => undefined);
      this.#set({ ...status, phase: 'done', done: total, source });
      void this.applyCacheLimit();
    } catch (error) {
      this.#set({ ...this.#status.get(id)!, phase: 'failed', error: errorOf(error) });
    }
  }

  /** The phone's copy in parts, a few in flight at once. */
  async #fromPhone(
    attachmentId: string,
    total: number,
    writer: Awaited<ReturnType<ReturnType<typeof fileCache>['writer']>>,
    progress: (done: number) => void,
  ): Promise<void> {
    let offset = writer.stored;
    let next = offset;
    const asked = new Map<number, Promise<{ data: Uint8Array; totalSize: number }>>();
    while (offset < total) {
      while (asked.size < PHONE_WINDOW && next < total) {
        const part = this.engine.fetchFromPhone(attachmentId, next, FILE_PART_BYTES);
        part.catch(() => undefined); // awaited below, or dropped after a short part
        asked.set(next, part);
        next += FILE_PART_BYTES;
      }
      const waiting = asked.get(offset);
      if (!waiting) {
        next = offset;
        continue;
      }
      asked.delete(offset);
      const part = await waiting;
      if (part.totalSize !== total || part.data.length === 0) {
        throw new TransferFailure(part.data.length === 0 ? 'missing' : 'integrity');
      }
      if (offset + part.data.length > total) throw new TransferFailure('integrity');
      await writer.append(part.data);
      offset += part.data.length;
      progress(offset);
      if (part.data.length !== FILE_PART_BYTES && offset < total) {
        // A short part: what was asked after it starts at the wrong place.
        asked.clear();
        next = offset;
      }
    }
    await writer.flush();
  }

  // Sending

  /** Prepares and sends a file; the upload runs after this resolves (the message shows it). */
  async sendFile(conversationId: string, file: File, options: SendFileOptions): Promise<void> {
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    const sniffed = sniffMime(head);
    const { category } = sniffed;
    let body: Blob = file;
    let mimeType = sniffed.mimeType;
    let media: Partial<MediaDetails> = {};
    let preview: EncodedImage | undefined;
    if (category === 'image') {
      if (!options.original && compressByDefault(mimeType)) {
        const out = await compressImage(file, IMAGE_PRESETS[options.quality]);
        body = out.blob;
        mimeType = 'image/jpeg';
        media = { width: out.width, height: out.height };
      } else {
        media = await imageSize(file).catch(() => ({}));
      }
      preview = await imageThumbnail(body);
    } else if (category === 'video' || category === 'audio') {
      const info = await mediaInfo(file, category);
      media = {
        ...(info.width ? { width: info.width } : {}),
        ...(info.height ? { height: info.height } : {}),
        ...(info.durationMs ? { durationMs: info.durationMs } : {}),
      };
      preview = info.thumbnail;
    }
    const check = canSend({ size: body.size, category: 'document' });
    if (check.result !== 'ok') {
      const limit = formatSize(DEFAULT_LIMITS.attachmentMaxBytes);
      throw new SendFileError(
        check.result === 'rejected' && check.reason === 'empty'
          ? 'This file is empty.'
          : category === 'video'
            ? `This video is ${formatSize(body.size)}, over the ${limit} limit. Videos can't be compressed in the browser: send it from your phone, which can.`
            : `This file is ${formatSize(body.size)}, over the ${limit} limit. It can't be sent.`,
      );
    }

    const thumb = preview ? await this.#encrypt(preview.blob) : undefined;
    const main = await this.#encrypt(body);
    const document = category === 'document' || category === 'audio';
    const manifest = buildManifest({
      attachmentId: main.attachmentId,
      encrypted: main.encrypted,
      mimeType,
      ...(document ? { fileName: file.name } : {}),
      ...(thumb && preview
        ? {
            thumbnail: buildManifest({
              attachmentId: thumb.attachmentId,
              encrypted: thumb.encrypted,
              mimeType: 'image/jpeg',
              media: { width: preview.width, height: preview.height },
            }),
          }
        : {}),
      caption: options.caption.trim(),
      media,
    });
    const message = await this.engine.sendAttachment(conversationId, manifest, {
      held: true,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.forwarded ? { forwarded: true } : {}),
    });
    await this.#savePending({
      messageId: message.messageId,
      attachmentIds: [...(thumb ? [thumb.attachmentId] : []), main.attachmentId],
      recipients: null,
    });
    void this.#upload(message.messageId);
  }

  /**
   * Forwards a cached file (Phase 39, ADR 0043): decrypted here, then sent again to each chat as
   * a new attachment (new key, new upload), with its caption, since the server's copy may be
   * gone (ADR 0017). False when the whole file is not in this browser.
   */
  async forwardFile(
    messageId: string,
    conversationIds: string[],
    forwarded: boolean,
  ): Promise<boolean> {
    const message = await this.engine.getMessage(messageId);
    const info = message?.kind === 'attachment' ? message.attachment : null;
    if (!message || !info || !(await fileCache().isComplete(info.attachmentId))) return false;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for await (const chunk of decryptStream(
      this.provider,
      attachmentDecryptInput(info),
      fileCache().read(info.attachmentId),
    )) {
      parts.push(new Uint8Array(chunk));
    }
    const kind = info.mimeType.split('/')[0] ?? 'file';
    const name = info.fileName ?? `pingdost-${kind}.${info.mimeType.split('/')[1] ?? 'bin'}`;
    const file = new File(parts, name, { type: info.mimeType });
    for (const conversationId of conversationIds) {
      await this.sendFile(conversationId, file, {
        caption: message.body,
        original: true,
        quality: 'standard',
        forwarded,
      });
    }
    return true;
  }

  /** Uploads still waiting (e.g. after a closed tab or a lost connection) are tried again. */
  async resumeUploads(): Promise<void> {
    for (const pending of await this.#pending()) void this.#upload(pending.messageId);
  }

  retryUpload(messageId: string): Promise<void> {
    return this.#upload(messageId);
  }

  async #encrypt(blob: Blob): Promise<{ attachmentId: string; encrypted: EncryptedAttachment }> {
    const attachmentId = uuidv7();
    const writer = await fileCache().writer(attachmentId, ciphertextSizeFor(blob.size), false);
    const stream = encryptStream(this.provider, blobChunks(blob));
    for (;;) {
      const step = await stream.next();
      if (step.done) {
        await writer.complete();
        return { attachmentId, encrypted: step.value };
      }
      await writer.append(step.value);
    }
  }

  async #upload(messageId: string): Promise<void> {
    if (this.#uploading.has(messageId)) return;
    this.#uploading.add(messageId);
    let current: TransferStatus | undefined;
    try {
      const pending = (await this.#pending()).find((p) => p.messageId === messageId);
      const message = await this.engine.getMessage(messageId);
      const info = message?.attachment;
      if (!pending || !message || !info || message.state !== 'local_queued') {
        if (pending) await this.#dropPending(messageId);
        return;
      }
      const infos = [...(info.thumbnail ? [info.thumbnail] : []), info];
      const total = infos.reduce((sum, i) => sum + i.ciphertextSize, 0);
      current = {
        attachmentId: info.attachmentId,
        messageId,
        direction: 'up',
        phase: 'running',
        done: 0,
        total,
        source: null,
        error: null,
      };
      this.#set(current);
      let recipients = pending.recipients;
      if (!recipients) {
        recipients = await this.engine.attachmentRecipients(message.conversationId);
        await this.#savePending({ ...pending, recipients });
      }
      const cache = fileCache();
      let sent = 0;
      for (const part of infos) {
        if (!(await cache.isComplete(part.attachmentId))) throw new TransferFailure('missing');
        // No other device to deliver to: nothing to stage.
        if (recipients.length > 0) {
          const base = sent;
          await uploadAttachment({
            api: api.attachments,
            attachmentId: part.attachmentId,
            ciphertextSize: part.ciphertextSize,
            ciphertextSha256: fromBase64(part.ciphertextSha256),
            recipientDeviceIds: recipients,
            ...(message.expiresAt !== null ? { expiresAt: message.expiresAt } : {}),
            readRange: (start, end) => cache.readRange(part.attachmentId, start, end),
            onProgress: (done) => this.#set({ ...current!, done: base + done }),
          });
        }
        sent += part.ciphertextSize;
      }
      await this.engine.releaseAttachment(messageId);
      await this.#dropPending(messageId);
      this.#set({ ...current, phase: 'done', done: total });
    } catch (error) {
      if (current) this.#set({ ...current, phase: 'failed', error: errorOf(error) });
    } finally {
      this.#uploading.delete(messageId);
    }
  }

  // The cache

  /** Keeps the cache under its limit; files in use and pending uploads stay. */
  async applyCacheLimit(): Promise<number> {
    return fileCache().evict(cacheLimitMb() * BYTES_PER_MB, await this.#inUse());
  }

  async clearCache(): Promise<number> {
    return fileCache().clear(await this.#inUse());
  }

  async #inUse(): Promise<Set<string>> {
    const keep = new Set(this.#running.keys());
    for (const pending of await this.#pending())
      for (const id of pending.attachmentIds) keep.add(id);
    return keep;
  }

  // Pending uploads, sealed in IndexedDB

  #sealed(): Promise<SealedRecords> {
    this.#records ??= (async () => new SealedRecords(database(), await vaultKey(database())))();
    return this.#records;
  }

  async #pending(): Promise<PendingUpload[]> {
    return (await (await this.#sealed()).get<PendingUpload[]>(PENDING)) ?? [];
  }

  async #savePending(entry: PendingUpload): Promise<void> {
    const list = (await this.#pending()).filter((p) => p.messageId !== entry.messageId);
    await (await this.#sealed()).put(PENDING, [...list, entry]);
  }

  async #dropPending(messageId: string): Promise<void> {
    const list = await this.#pending();
    await (
      await this.#sealed()
    ).put(
      PENDING,
      list.filter((p) => p.messageId !== messageId),
    );
  }

  #set(status: TransferStatus): void {
    this.#status.set(
      status.direction === 'up' ? `up:${status.messageId}` : status.attachmentId,
      status,
    );
    this.announce(status);
  }
}
