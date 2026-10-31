// Making a backup on this phone (REQ §6.3, ADR 0022): the history, contacts' verified keys,
// group keys, the account identity key and the app's own settings, optionally with the
// downloaded files, encrypted under the recovery phrase. The file goes to the cache first,
// then to a folder the user picks (Android's Storage Access Framework) or the share sheet.
// Nothing is uploaded to PingDost.
import Constants from 'expo-constants';
import { Directory, File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';

import { authStore } from '@/api';
import { readChunks, vaultFile } from '@/attachments/files';
import { AttachmentRepo } from '@/attachments/repo';
import { storageUsage } from '@/attachments/storage';
import { getCryptoContext } from '@/crypto/bootstrap';
import { getOrCreateSecret, SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { SETTING_KEYS } from '@/db/settings';
import { SqliteEngineStore, type SqlDatabase } from '@/engine/sqlite-store';
import {
  BACKUP_MIME_TYPE,
  backupFileName,
  BackupWriter,
  exportToBackup,
  type ExportCounts,
} from '@pingdost/backup';

import { backupDir, clearBackupDir, copyFile, fileSink } from './io';
import { useBackupPrefs } from './prefs';

/** App settings that travel in a backup (both local to the phone; privacy is on the server). */
const BACKED_UP_SETTINGS = [SETTING_KEYS.notifications, SETTING_KEYS.attachments] as const;

export interface CreatedBackup {
  file: File;
  bytes: number;
  counts: ExportCounts;
}

export class BackupUnavailableError extends Error {
  constructor() {
    super('Only the phone that holds your account key can make a backup.');
    this.name = 'BackupUnavailableError';
  }
}

/** Bytes of downloaded and sent files on this phone: the size warning for "include files". */
export async function filesSize(): Promise<number> {
  const usage = await storageUsage();
  return usage.mediaBytes + usage.thumbnailBytes;
}

async function appSettings(db: SqlDatabase): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const key of BACKED_UP_SETTINGS) {
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM local_settings WHERE key = ?',
      [key],
    );
    if (row) values[key] = JSON.parse(row.value) as unknown;
  }
  return values;
}

/**
 * Writes a new backup to the cache folder. Slow on purpose at the start (the key derivation
 * takes a few seconds), then about as fast as the storage.
 */
export async function createBackup(
  entropy: Uint8Array,
  options: { includeFiles: boolean; onProgress?: (counts: ExportCounts) => void },
): Promise<CreatedBackup> {
  const session = authStore.getState().session;
  if (!session) throw new Error('not signed in');
  const context = await getCryptoContext();
  const { db } = context.database;
  const secret = await SecureStore.getItemAsync(
    SECRET_ITEMS.accountIdentityKey,
    SECURE_STORE_OPTIONS,
  );
  if (!secret) throw new BackupUnavailableError();
  const identity = context.provider.restoreSigningKey(secret);
  const accountIdentityKey = identity.publicKey();
  identity.dispose();
  const pickleKey = await getOrCreateSecret(SECRET_ITEMS.pickleKey);
  const store = new SqliteEngineStore(db);
  const repo = new AttachmentRepo(db);

  clearBackupDir();
  const createdAt = Date.now();
  const file = new File(backupDir(), backupFileName(new Date(createdAt)));
  const sink = fileSink(file);
  try {
    const writer = await BackupWriter.create({
      crypto: context.provider,
      entropy,
      sink,
      manifest: {
        createdAt,
        userId: session.user.userId,
        accountIdentityKey,
        app: `pingdost-android/${Constants.expoConfig?.version ?? '0'}`,
        includesFiles: options.includeFiles,
      },
    });
    const counts = await exportToBackup({
      store,
      crypto: context.provider,
      pickleKey,
      writer,
      selfUserId: session.user.userId,
      identitySecret: secret,
      settings: await appSettings(db),
      ...(options.includeFiles
        ? {
            file: async (attachment) => {
              const row = await repo.get(attachment.attachmentId);
              if (row?.state !== 'done' || !row.localPath) return null;
              const local = vaultFile(row.localPath);
              if (!local.exists) return null;
              return { size: local.size, chunks: () => readChunks(local, { size: 65_536 }) };
            },
          }
        : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    const { bytes } = await writer.finish();
    sink.close();
    await useBackupPrefs.getState().update({ lastBackupAt: createdAt, lastBackupBytes: bytes });
    return { file, bytes, counts };
  } catch (error) {
    sink.close();
    clearBackupDir();
    throw error;
  }
}

/** Saves the backup into a folder the user picks (SAF). False if they cancelled. */
export async function saveToFolder(backup: CreatedBackup): Promise<boolean> {
  let folder: Directory;
  try {
    folder = await Directory.pickDirectoryAsync();
  } catch {
    return false; // cancelled
  }
  const target = folder.createFile(backup.file.name, BACKUP_MIME_TYPE);
  await copyFile(backup.file, target);
  return true;
}

/** Hands the backup to the share sheet (Drive, Files, a USB drive app, …). */
export async function shareBackup(backup: CreatedBackup): Promise<void> {
  await Sharing.shareAsync(backup.file.uri, {
    mimeType: BACKUP_MIME_TYPE,
    dialogTitle: 'Save your PingDost backup',
  });
}

/** Removes the cached copy once the user has saved it somewhere. */
export function discardCachedBackup(): void {
  clearBackupDir();
}
