// Opening a cached attachment in this tab (ADR 0021): its ciphertext is read from IndexedDB,
// decrypted with the key from the sealed message record (every chunk authenticated, then the
// whole-file hash checked), and shown from an object URL that only this tab holds. The
// plaintext is never written anywhere. Files that are not images, video or audio are only
// ever downloaded, never opened in a page: a document cannot run in PingDost's origin.
import { cryptoProvider } from '@/crypto/provider';
import { decryptStream } from '@pingdost/attachments';
import { attachmentDecryptInput, type AttachmentInfo } from '@pingdost/message-engine';

import { fileCache } from './cache';

/** Object URLs kept per tab, oldest dropped first. */
const MAX_URLS = 40;
const urls = new Map<string, Promise<string>>();

const SHOWN =
  /^(image\/(jpeg|png|webp|gif|avif|heic|heif)|video\/(mp4|webm|quicktime|3gpp)|audio\/.+)$/;

/** Whether this kind of file is shown in the page (else it is offered as a download). */
export function shownInline(mimeType: string): boolean {
  return SHOWN.test(mimeType);
}

export async function decryptToBlob(info: AttachmentInfo): Promise<Blob> {
  const provider = await cryptoProvider();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of decryptStream(
    provider,
    attachmentDecryptInput(info),
    fileCache().read(info.attachmentId),
  )) {
    parts.push(new Uint8Array(chunk));
  }
  // A document is labelled as plain bytes, so the browser only ever saves it.
  return new Blob(parts, {
    type: shownInline(info.mimeType) ? info.mimeType : 'application/octet-stream',
  });
}

/** An object URL for a cached attachment (decrypted once per tab). */
export function objectUrl(info: AttachmentInfo): Promise<string> {
  const existing = urls.get(info.attachmentId);
  if (existing) {
    urls.delete(info.attachmentId);
    urls.set(info.attachmentId, existing);
    return existing;
  }
  const made = decryptToBlob(info).then((blob) => URL.createObjectURL(blob));
  made.catch(() => urls.delete(info.attachmentId));
  urls.set(info.attachmentId, made);
  while (urls.size > MAX_URLS) {
    const [oldest, url] = urls.entries().next().value!;
    urls.delete(oldest);
    void url.then(
      (u) => URL.revokeObjectURL(u),
      () => undefined,
    );
  }
  return made;
}

/** Saves a cached attachment to the computer under its name. */
export async function saveFile(info: AttachmentInfo, fallbackName: string): Promise<void> {
  const url = URL.createObjectURL(await decryptToBlob(info));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = info.fileName ?? fallbackName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** Drops this tab's decrypted copies (cache cleared, file deleted). */
export function forgetUrls(attachmentIds?: readonly string[]): void {
  for (const [id, url] of [...urls]) {
    if (attachmentIds && !attachmentIds.includes(id)) continue;
    urls.delete(id);
    void url.then(
      (u) => URL.revokeObjectURL(u),
      () => undefined,
    );
  }
}
