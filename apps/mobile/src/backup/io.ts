// Backup files on this phone (ADR 0022) through expo-file-system handles, in chunks: a backup
// can hold hundreds of megabytes of files, so it is never read or written whole.
import type { File } from 'expo-file-system';
import { Directory, FileMode, Paths } from 'expo-file-system';

import type { BackupSink, BackupSource } from '@pingdost/backup';

/** `<cache>/pingdost-backup/`: the newest backup before it is saved or shared, then deleted. */
export function backupDir(): Directory {
  const dir = new Directory(Paths.cache, 'pingdost-backup');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Deletes every file in the backup folder (a finished or abandoned backup). */
export function clearBackupDir(): void {
  try {
    for (const entry of backupDir().list()) entry.delete();
  } catch {
    // Nothing to clear.
  }
}

export interface FileSink extends BackupSink {
  close(): void;
}

/** Writes a new file (replacing it). */
export function fileSink(file: File): FileSink {
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  const handle = file.open(FileMode.Truncate);
  return {
    write: async (bytes) => {
      await handle.writeBytes(bytes);
    },
    close: () => handle.close(),
  };
}

export interface FileSource extends BackupSource {
  close(): void;
}

/** Random access to a local file (`BackupReader` reads it twice). */
export function fileSource(file: File): FileSource {
  const handle = file.open(FileMode.ReadOnly);
  const size = handle.size ?? file.size;
  return {
    size,
    read: async (offset, length) => {
      handle.offset = offset;
      return handle.readBytes(Math.min(length, size - offset));
    },
    close: () => handle.close(),
  };
}

/** Copies `from` into `to` in 1 MiB steps (e.g. into a folder the user picked). */
export async function copyFile(from: File, to: File): Promise<void> {
  const source = from.open(FileMode.ReadOnly);
  const target = to.open(FileMode.Truncate);
  try {
    const size = source.size ?? from.size;
    let offset = 0;
    while (offset < size) {
      const bytes = await source.readBytes(Math.min(1_048_576, size - offset));
      if (bytes.length === 0) break;
      await target.writeBytes(bytes);
      offset += bytes.length;
    }
  } finally {
    source.close();
    target.close();
  }
}
