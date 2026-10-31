// Restoring a backup on a new phone (ADR 0022). The file is copied into the cache first (the
// picker's copy), opened with the phrase, checked against the signed-in account and verified
// end to end before anything on the server changes; only then is the old phone replaced and
// the history written into this phone's (empty) database.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import { removeFile, vaultFile } from '@/attachments/files';
import { AttachmentRepo } from '@/attachments/repo';
import { getCryptoContext } from '@/crypto/bootstrap';
import { SETTING_KEYS, writeSetting } from '@/db/settings';
import { SqliteEngineStore } from '@/engine/sqlite-store';
import {
  BackupError,
  BackupReader,
  HEADER_LENGTH,
  phraseEntropy,
  restoreFromBackup,
  type BackupManifest,
  type RestoreResult,
} from '@pingdost/backup';

import { fileSink, fileSource, type FileSource } from './io';

export interface PickedBackup {
  file: File;
  name: string;
  size: number;
}

/** The system file picker; the chosen file is copied into the cache. Null if cancelled. */
export async function pickBackupFile(): Promise<PickedBackup | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  return { file, name: asset.name, size: file.size };
}

export interface OpenedBackup {
  reader: BackupReader;
  manifest: BackupManifest;
  /** Closes the file and deletes the cached copy. */
  close(): void;
}

/**
 * Opens the picked file with the phrase. Throws `BackupError` (`not_a_backup`,
 * `invalid_phrase`, `wrong_phrase`, …). The key derivation blocks for a few seconds.
 */
export async function openBackup(
  picked: PickedBackup,
  phrase: string | readonly string[],
): Promise<OpenedBackup> {
  const entropy = phraseEntropy(phrase);
  const { provider } = await getCryptoContext();
  if (picked.size < HEADER_LENGTH) throw new BackupError('not_a_backup');
  let source: FileSource | undefined;
  try {
    source = fileSource(picked.file);
    const reader = await BackupReader.open(provider, source, entropy);
    const opened = source;
    return {
      reader,
      manifest: reader.manifest,
      close: () => {
        reader.dispose();
        opened.close();
        removeFile(picked.file);
      },
    };
  } catch (error) {
    source?.close();
    throw error;
  } finally {
    entropy.fill(0);
  }
}

/**
 * Writes the backup into this phone's database under its new pickle key, with the files it
 * carries back into the vault (as downloaded attachments). Run on an empty database, after
 * `reader.verify()` passed.
 */
export async function restoreIntoPhone(
  opened: OpenedBackup,
  verified: { records: number },
  pickleKey: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<RestoreResult> {
  const context = await getCryptoContext();
  const { db } = context.database;
  const store = new SqliteEngineStore(db);
  const repo = new AttachmentRepo(db);
  const result = await restoreFromBackup({
    reader: opened.reader,
    store,
    crypto: context.provider,
    pickleKey,
    verified,
    ...(onProgress ? { onProgress: ({ records, total }) => onProgress(records, total) } : {}),
    file: (record) => {
      const target = vaultFile(record.attachmentId);
      const sink = fileSink(target);
      return Promise.resolve({
        write: (bytes) => sink.write(bytes),
        close: async () => {
          sink.close();
          const now = Date.now();
          await repo.insert([
            {
              attachmentId: record.attachmentId,
              messageId: record.messageId,
              conversationId: record.conversationId,
              role: record.role,
              direction: 'down',
              state: 'done',
              ciphertextSize: record.size,
              transferred: record.size,
              localPath: record.attachmentId,
              error: null,
              recipients: null,
              createdAt: now,
              updatedAt: now,
            },
          ]);
        },
        abort: () => {
          sink.close();
          removeFile(target);
          return Promise.resolve();
        },
      });
    },
  });
  for (const [key, value] of Object.entries(result.settings ?? {})) {
    if (key === SETTING_KEYS.notifications || key === SETTING_KEYS.attachments) {
      await writeSetting(db, key, value);
    }
  }
  // The engine asks these contacts' devices for new sessions once it runs (`runtime.ts`).
  await writeSetting(db, SETTING_KEYS.announce, result.peerUserIds);
  return result;
}
