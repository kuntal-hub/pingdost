// Plaintext only while a file is looked at (ARCHITECTURE A6, ADR 0018): opening decrypts the
// vault copy into the view cache, and the copy is deleted when the viewer closes, when the app
// leaves the foreground, or, for a file handed to another app (which reads it after PingDost
// is in the background), after a timeout. Everything left over goes at the next start.
import { Directory, File } from 'expo-file-system';
import { AppState } from 'react-native';

import { safeFileName } from '@pingdost/attachments';
import type { AttachmentInfo } from '@pingdost/message-engine';

import { attachmentContext } from './context';
import { clearFolder, removeFile, viewDir } from './files';
import { decryptToFile } from './pipeline';

/** How long a file handed to another app stays readable. */
const EXPORT_TTL_MS = 10 * 60_000;

interface Opened {
  file: File;
  users: number;
  /** Exports stay until then, even with no user. */
  keepUntil: number;
}

const opened = new Map<string, Opened>();
const opening = new Map<string, Promise<File>>();

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/x-matroska': 'mkv',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/amr': 'amr',
  'audio/3gpp': '3gp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
};

export function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? 'bin';
}

/** The name a file is shown and exported under: its own for documents, else by type. */
export function displayName(info: AttachmentInfo): string {
  const own = safeFileName(info.fileName ?? undefined);
  if (own) return own;
  const kind = info.mimeType.split('/')[0] ?? 'file';
  const word =
    kind === 'image' ? 'photo' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'file';
  return `pingdost-${word}.${extensionFor(info.mimeType)}`;
}

/**
 * The file decrypted for viewing (`release` when done) or for handing to another app
 * (`exported`: kept for a few minutes).
 */
export async function openPlaintext(
  info: AttachmentInfo,
  options: { exported?: boolean } = {},
): Promise<File> {
  const key = info.attachmentId;
  const existing = opened.get(key);
  if (existing?.file.exists) {
    existing.users++;
    if (options.exported) existing.keepUntil = Date.now() + EXPORT_TTL_MS;
    return existing.file;
  }
  let pending = opening.get(key);
  if (!pending) {
    pending = (async () => {
      // One folder per file, so documents keep their own names.
      const folder = new Directory(viewDir(), key);
      if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
      const file = new File(folder, displayName(info));
      await decryptToFile(attachmentContext().provider, info, file);
      return file;
    })().finally(() => opening.delete(key));
    opening.set(key, pending);
  }
  const file = await pending;
  const entry = opened.get(key) ?? { file, users: 0, keepUntil: 0 };
  entry.users++;
  if (options.exported) entry.keepUntil = Date.now() + EXPORT_TTL_MS;
  opened.set(key, entry);
  return file;
}

/** The viewer closed: the plaintext goes unless it is still exported or shown elsewhere. */
export function releasePlaintext(attachmentId: string): void {
  const entry = opened.get(attachmentId);
  if (!entry) return;
  entry.users = Math.max(0, entry.users - 1);
  if (entry.users === 0 && entry.keepUntil < Date.now()) drop(attachmentId, entry);
}

function drop(key: string, entry: Opened): void {
  opened.delete(key);
  removeFile(entry.file);
  try {
    entry.file.parentDirectory.delete();
  } catch {
    // Already gone.
  }
}

/** Deletes plaintext no viewer uses; exports only once their time is up (or `all`). */
export function sweepPlaintext(all = false): void {
  const now = Date.now();
  for (const [key, entry] of opened) {
    if (all || (entry.users === 0 && entry.keepUntil < now)) drop(key, entry);
  }
}

/** At start: nothing in the view cache belongs to anyone any more. */
export function clearPlaintext(): number {
  opened.clear();
  return clearFolder(viewDir());
}

/** Deletes plaintext when the app leaves the foreground and expired exports on return. */
export function watchPlaintext(): () => void {
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'background') {
      // Viewers are not on screen any more; exports are still being read by the other app.
      for (const [key, entry] of opened) if (entry.keepUntil < Date.now()) drop(key, entry);
    } else if (state === 'active') {
      sweepPlaintext();
    }
  });
  return () => subscription.remove();
}
