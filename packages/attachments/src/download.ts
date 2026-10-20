/**
 * Downloading a staged attachment's ciphertext (REQ §10.2): the bytes come from a short-lived
 * signed URL as a streamed response and go to the caller's sink as they arrive, so a large file
 * is never held whole. An interrupted download resumes with a Range request after the bytes
 * already saved; an expired URL is renewed. The caller checks the saved ciphertext
 * (`verifyStream`) before it acknowledges, and only then may the server delete its copy.
 */
import type { AttachmentsApi } from '@pingdost/api-client';

import { AttachmentError } from './stream';
import { throwIfAborted } from './upload';

export interface DownloadInput {
  api: AttachmentsApi;
  attachmentId: string;
  /** From the manifest: the staged object must be exactly this long. */
  ciphertextSize: number;
  /** Bytes an earlier attempt already saved (they stay; the rest is fetched). */
  savedBytes: number;
  /** Appends bytes to the saved copy. */
  write: (chunk: Uint8Array) => Promise<void>;
  /** Drops the saved copy: the server sent the whole file instead of the range. */
  reset: () => Promise<void>;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  /** Pauses or cancels (`AttachmentError('aborted')`); the saved bytes are kept. */
  signal?: AbortSignal;
  /** Must stream `response.body` (expo/fetch on Android, the browser's fetch on web). */
  fetch?: typeof fetch;
  /** Attempts for transient failures. */
  attempts?: number;
}

/** Bytes are written in pieces of about this size, not per network read. */
const WRITE_BYTES = 262_144;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** An API error worth retrying: no response, or the server was briefly unavailable. */
function transient(error: unknown): boolean {
  const { kind, status } = (error ?? {}) as { kind?: string; status?: number };
  return kind === 'network' || kind === 'timeout' || (status !== undefined && status >= 502);
}

/** Fetches whatever of the ciphertext is not saved yet. Safe to call again after any failure. */
export async function downloadCiphertext(input: DownloadInput): Promise<void> {
  const { api, attachmentId, signal } = input;
  const fetchImpl = input.fetch ?? fetch;
  const attempts = input.attempts ?? 4;
  const total = input.ciphertextSize;
  let saved = input.savedBytes;
  if (saved > total) {
    await input.reset();
    saved = 0;
  }
  input.onProgress?.(saved, total);

  let url: string | undefined;
  let failures = 0;
  const retry = async (reason: string) => {
    failures++;
    throwIfAborted(signal);
    if (failures >= attempts) throw new AttachmentError('network', reason);
    await sleep(Math.min(8_000, 500 * 2 ** failures));
  };

  while (saved < total) {
    throwIfAborted(signal);
    if (!url) {
      try {
        const link = await api.downloadUrl(attachmentId);
        if (link.ciphertextBytes !== total) {
          throw new AttachmentError('integrity', 'the staged file has another size');
        }
        url = link.url;
      } catch (error) {
        const code = codeOf(error);
        if (code === 'ATTACHMENT_NOT_FOUND' || code === 'ATTACHMENT_EXPIRED') {
          throw new AttachmentError('gone', 'the file is no longer on the server');
        }
        if (error instanceof AttachmentError || !transient(error)) throw error;
        await retry('could not reach the server');
        continue;
      }
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...(saved > 0 ? { headers: { range: `bytes=${saved}-` } } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch {
      await retry('the download failed');
      continue;
    }
    if (response.status === 403 || response.status === 410) {
      // The signed URL expired: ask for a fresh one.
      url = undefined;
      await retry('the download link expired');
      continue;
    }
    if (response.status === 404) throw new AttachmentError('gone', 'the file is gone');
    if (response.status === 416) {
      await input.reset();
      saved = 0;
      await retry('the saved part did not match');
      continue;
    }
    if (response.status !== 200 && response.status !== 206) {
      await retry(`the server answered ${response.status}`);
      continue;
    }
    if (response.status === 200 && saved > 0) {
      // The whole file came back: start over.
      await input.reset();
      saved = 0;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AttachmentError('invalid', 'this platform cannot stream downloads');

    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const piece = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const part of pending) {
        piece.set(part, offset);
        offset += part.length;
      }
      pending = [];
      pendingBytes = 0;
      await input.write(piece);
      saved += piece.length;
      input.onProgress?.(saved, total);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (saved + pendingBytes + value.length > total) {
          throw new AttachmentError('integrity', 'the download is longer than the file');
        }
        pending.push(value);
        pendingBytes += value.length;
        if (pendingBytes >= WRITE_BYTES) await flush();
      }
      await flush();
    } catch (error) {
      // Keep what arrived, so a resume does not fetch it again.
      if (!(error instanceof AttachmentError)) await flush().catch(() => undefined);
      void reader.cancel().catch(() => undefined);
      if (error instanceof AttachmentError) throw error;
      await retry('the download was cut off');
      continue;
    }
    if (saved < total) await retry('the download was cut short');
  }
  throwIfAborted(signal);
}
