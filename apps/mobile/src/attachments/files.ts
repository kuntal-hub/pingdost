// Attachment files on this phone (REQ §14.1, ARCHITECTURE A6, ADR 0018), through the
// expo-file-system File API in chunks (never base64, never a whole large file in memory):
// - vault: `<documents>/attachments/<attachmentId>`, each the attachment's own encrypted
//   STREAM ciphertext; the key is in the SQLCipher DB (`messages.attachment`);
// - view: `<cache>/pingdost-view/`, plaintext decrypted only to show or export a file, deleted
//   soon after (`view.ts`);
// - work: `<cache>/pingdost-work/`, picked copies and compression output before encryption.
import { Directory, File, FileMode, Paths } from 'expo-file-system';

/** Bytes per read: big enough for few native calls, small enough to keep memory flat. */
export const READ_BYTES = 1_048_576;

function folder(parent: Directory, name: string): Directory {
  const dir = new Directory(parent, name);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export const vaultDir = () => folder(Paths.document, 'attachments');
export const viewDir = () => folder(Paths.cache, 'pingdost-view');
export const workDir = () => folder(Paths.cache, 'pingdost-work');

/** The encrypted copy of one attachment (it may not exist yet). */
export function vaultFile(attachmentId: string): File {
  return new File(vaultDir(), attachmentId);
}

/** A fresh file in the work folder. */
export function workFile(name: string): File {
  const file = new File(workDir(), name);
  if (file.exists) file.delete();
  return file;
}

/** Deletes a file if it is there; never throws. */
export function removeFile(file: File | string): void {
  try {
    const target = typeof file === 'string' ? new File(file) : file;
    if (target.exists) target.delete();
  } catch {
    // Already gone, or not ours to delete.
  }
}

/** Empties a folder; never throws. */
export function clearFolder(dir: Directory): number {
  let freed = 0;
  try {
    for (const entry of dir.list()) {
      try {
        if (entry instanceof File) freed += entry.size;
        entry.delete();
      } catch {
        // Keep going.
      }
    }
  } catch {
    // The folder is gone.
  }
  return freed;
}

/** The bytes of a file in order, `size` at a time, from `start` to `end` (exclusive). */
export async function* readChunks(
  file: File,
  options: { start?: number; end?: number; size?: number } = {},
): AsyncGenerator<Uint8Array> {
  const handle = file.open(FileMode.ReadOnly);
  try {
    const end = Math.min(options.end ?? Infinity, handle.size ?? 0);
    let offset = options.start ?? 0;
    handle.offset = offset;
    while (offset < end) {
      const bytes = await handle.readBytes(Math.min(options.size ?? READ_BYTES, end - offset));
      if (bytes.length === 0) break;
      offset += bytes.length;
      yield bytes;
    }
  } finally {
    handle.close();
  }
}

/** Bytes `[start, end)` of a file (an upload part). */
export async function readRange(file: File, start: number, end: number): Promise<Uint8Array> {
  const handle = file.open(FileMode.ReadOnly);
  try {
    handle.offset = start;
    return await handle.readBytes(end - start);
  } finally {
    handle.close();
  }
}

/** The first bytes of a file, for `sniffMime`. */
export async function readHead(file: File, length: number): Promise<Uint8Array> {
  return readRange(file, 0, Math.min(length, file.size));
}

/** Writes a stream to `file` (replacing it); returns the bytes written. */
export async function writeChunks(file: File, chunks: AsyncIterable<Uint8Array>): Promise<number> {
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  const handle = file.open(FileMode.Truncate);
  let written = 0;
  try {
    for await (const chunk of chunks) {
      await handle.writeBytes(chunk);
      written += chunk.length;
    }
  } finally {
    handle.close();
  }
  return written;
}

/** Appends to a file that may already hold an interrupted download. */
export class Appender {
  #handle: ReturnType<File['open']> | undefined;

  constructor(readonly file: File) {}

  /** Bytes already in the file. */
  get size(): number {
    return this.file.exists ? this.file.size : 0;
  }

  #open() {
    if (!this.#handle) {
      if (!this.file.exists) this.file.create({ intermediates: true });
      this.#handle = this.file.open(FileMode.ReadWrite);
      this.#handle.offset = this.#handle.size ?? 0;
    }
    return this.#handle;
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.#open().writeBytes(chunk);
  }

  /** Starts the file over, empty. */
  reset(): Promise<void> {
    this.close();
    removeFile(this.file);
    return Promise.resolve();
  }

  close(): void {
    this.#handle?.close();
    this.#handle = undefined;
  }
}
