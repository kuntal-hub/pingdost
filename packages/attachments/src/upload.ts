/**
 * Uploading an encrypted attachment to staging (REQ §10.2): the ciphertext goes in parts (of
 * the server's `partSize`) to short-lived signed URLs; a resumed upload asks the server which parts it has
 * and sends only the rest; `complete` makes the server check size and SHA-256 before anyone
 * can download. The caller reads parts from its local encrypted copy (ADR 0004: attachments
 * are kept encrypted on the device), so a resume never re-encrypts.
 */
import type { AttachmentsApi } from '@pingdost/api-client';
import type { AttachmentStatusResponse, UploadUrl } from '@pingdost/shared-types';

import { partCountFor } from './constants';
import { AttachmentError } from './stream';

export interface UploadInput {
  api: AttachmentsApi;
  attachmentId: string;
  ciphertextSize: number;
  ciphertextSha256: Uint8Array;
  /** The recipients' devices and this user's other devices. */
  recipientDeviceIds: string[];
  /** The linked message's expiry. */
  expiresAt?: number;
  /** Bytes `[start, end)` of the ciphertext. */
  readRange: (start: number, end: number) => Promise<Uint8Array>;
  /** Sends one part to its signed URL; default `fetch` PUT. Resolves with the HTTP status. */
  sendPart?: (url: string, body: Uint8Array) => Promise<number>;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  /** Attempts per part for transient failures. */
  attempts?: number;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Unpadded base64, as the REST DTOs carry hashes. */
export function unpaddedBase64(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const n = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!;
    if (i + 1 < data.length) out += BASE64[(n >> 6) & 63]!;
    if (i + 2 < data.length) out += BASE64[n & 63]!;
  }
  return out;
}

async function defaultSendPart(url: string, body: Uint8Array): Promise<number> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    // Parts are read into plain ArrayBuffers.
    body: body as Uint8Array<ArrayBuffer>,
  });
  return response.status;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates (or resumes) the staged upload and sends every missing part, then completes it.
 * Safe to call again after any failure: it continues where the server left off.
 */
export async function uploadAttachment(input: UploadInput): Promise<AttachmentStatusResponse> {
  const { api, attachmentId } = input;
  const sendPart = input.sendPart ?? defaultSendPart;
  const attempts = input.attempts ?? 4;

  let status: AttachmentStatusResponse;
  try {
    const created = await api.create({
      attachmentId,
      ciphertextBytes: input.ciphertextSize,
      ciphertextSha256: unpaddedBase64(input.ciphertextSha256),
      recipientDeviceIds: input.recipientDeviceIds,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
    status = {
      attachmentId,
      status: 'uploading',
      partSize: created.partSize,
      partCount: created.partCount,
      receivedParts: [],
      uploadUrls: created.uploadUrls,
      urlsExpireAt: created.urlsExpireAt,
      expiresAt: created.expiresAt,
    };
  } catch (error) {
    // Created before (an earlier attempt): resume.
    if ((error as { code?: string }).code !== 'CONFLICT') throw error;
    status = await api.status(attachmentId);
  }
  if (status.status === 'ready') return status;

  // The server decides the part size (it depends on its store).
  const { partSize, partCount } = status;
  if (partCount !== partCountFor(input.ciphertextSize, partSize)) {
    throw new AttachmentError('invalid', 'the server expects another size');
  }
  const partLength = (index: number) => Math.min(partSize, input.ciphertextSize - index * partSize);
  const received = new Set(status.receivedParts);
  let urls = new Map(status.uploadUrls.map((u: UploadUrl) => [u.index, u.url]));
  let sent = [...received].reduce((n, i) => n + partLength(i), 0);
  input.onProgress?.(sent, input.ciphertextSize);

  for (let index = 0; index < partCount; index++) {
    if (received.has(index)) continue;
    const start = index * partSize;
    const body = await input.readRange(start, start + partLength(index));
    for (let attempt = 1; ; attempt++) {
      let url = urls.get(index);
      if (!url) {
        const fresh = await api.status(attachmentId);
        urls = new Map(fresh.uploadUrls.map((u) => [u.index, u.url]));
        url = urls.get(index);
        if (!url) break; // the server already has it
      }
      let code: number;
      try {
        code = await sendPart(url, body);
      } catch {
        code = 0; // network
      }
      if (code >= 200 && code < 300) break;
      if (code === 403 || code === 410) {
        // The URL expired: get fresh ones.
        urls.delete(index);
      } else if (code === 413 || code === 400) {
        throw new AttachmentError('invalid', `part ${index} was refused`);
      }
      if (attempt >= attempts)
        throw new AttachmentError('integrity', `part ${index} did not upload`);
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
    }
    sent += body.length;
    input.onProgress?.(sent, input.ciphertextSize);
  }
  const done = await api.complete(attachmentId);
  if (done.status !== 'ready') throw new AttachmentError('integrity', 'the upload is incomplete');
  return done;
}
