// Storage controls (REQ §14.1, §14.3; ADR 0018): what PingDost keeps on this phone, and ways
// to free space that never touch chat history. "Clear cache" removes previews and temporary
// files only; deleting media removes a chat's local file copies, while the messages stay.
import type { Directory } from 'expo-file-system';
import { File, Paths } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';

import { DATABASE_NAME } from '@/db/open';

import { attachmentContext } from './context';
import { clearFolder, removeFile, vaultDir, vaultFile, viewDir, workDir } from './files';
import { forgetThumbnails } from './hooks';
import type { ChatUsage } from './repo';
import { useTransferStore } from './transfers';
import { clearPlaintext } from './view';

export interface StorageUsage {
  /** Encrypted files and previews kept for chats. */
  mediaBytes: number;
  thumbnailBytes: number;
  /** Temporary files: plaintext being viewed, picker copies, compression output. */
  cacheBytes: number;
  /** The encrypted message database. */
  databaseBytes: number;
  chats: ChatUsage[];
  /** Free space on the phone. */
  freeBytes: number;
}

function folderBytes(dir: Directory): number {
  try {
    return dir.exists ? (dir.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

function databaseBytes(): number {
  const dir = String(defaultDatabaseDirectory);
  const folder = dir.startsWith('file://') ? dir : `file://${dir}`;
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const file = new File(folder, `${DATABASE_NAME}${suffix}`);
      if (file.exists) total += file.size;
    } catch {
      // Not there.
    }
  }
  return total;
}

export async function storageUsage(): Promise<StorageUsage> {
  const chats = await attachmentContext().repo.usageByConversation();
  return {
    mediaBytes: chats.reduce((n, c) => n + c.fileBytes, 0),
    thumbnailBytes: chats.reduce((n, c) => n + c.thumbnailBytes, 0),
    cacheBytes: folderBytes(viewDir()) + folderBytes(workDir()),
    databaseBytes: databaseBytes(),
    chats,
    freeBytes: Paths.availableDiskSpace,
  };
}

/**
 * Clears previews and temporary files. Messages and downloaded files stay; a cleared preview
 * shows as a plain file card from then on (the server copy is gone once fetched).
 */
export async function clearCache(): Promise<number> {
  const { repo } = attachmentContext();
  let freed = clearPlaintext() + clearFolder(workDir());
  const done = await repo.inStates(['done']);
  for (const row of done) {
    if (row.role !== 'thumbnail' || !row.localPath) continue;
    const file = vaultFile(row.localPath);
    freed += file.exists ? file.size : 0;
    removeFile(file);
    await repo.update(row.attachmentId, { state: 'removed', localPath: null });
    bump(row.messageId);
  }
  forgetThumbnails();
  return freed;
}

/** Deletes the local copies of these files; their messages stay and say so. */
export async function deleteMedia(attachmentIds: readonly string[]): Promise<number> {
  const { repo } = attachmentContext();
  let freed = 0;
  for (const id of attachmentIds) {
    const row = await repo.get(id);
    if (!row?.localPath) continue;
    const file = vaultFile(row.localPath);
    freed += file.exists ? file.size : 0;
    removeFile(file);
    await repo.update(id, { state: 'removed', localPath: null });
    bump(row.messageId);
  }
  return freed;
}

function bump(messageId: string): void {
  useTransferStore.setState((state) => ({
    revisions: { ...state.revisions, [messageId]: (state.revisions[messageId] ?? 0) + 1 },
  }));
}

/** This device was revoked: every attachment file goes with its chats. */
export function wipeAttachmentFiles(): void {
  clearFolder(vaultDir());
  clearPlaintext();
  clearFolder(workDir());
  forgetThumbnails();
}
