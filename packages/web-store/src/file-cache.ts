/**
 * The browser's attachment cache (REQ §14.2, ADR 0021). Each file is kept as its ciphertext
 * exactly as staged: the attachment's own STREAM encryption (ADR 0004), whose key lives only
 * in the sealed message record. So the cache needs no second seal, and a file read back can
 * be checked against its manifest like a fresh download.
 *
 * - Bytes are written in order, in pieces of up to 1 MiB; `stored` counts only pieces that
 *   reached IndexedDB, so an interrupted transfer resumes right after them.
 * - Over the size limit, the least recently used files go first. It is a cache: clearing it,
 *   or the browser evicting it, never touches the chat history.
 */
import type { PingdostDb } from './db';

/** Bytes per stored piece. */
export const FILE_PIECE_BYTES = 1_048_576;

export interface FileWriter {
  /** Bytes already stored (a resumed transfer continues from here). */
  readonly stored: number;
  append(chunk: Uint8Array): Promise<void>;
  /** Writes what is buffered. */
  flush(): Promise<void>;
  /** Drops what was stored and starts the file over. */
  reset(): Promise<void>;
  /** Everything is here and checked. */
  complete(): Promise<void>;
}

export class FileCache {
  constructor(
    private readonly db: PingdostDb,
    private readonly now: () => number = Date.now,
    /** Bytes per stored piece (tests use small ones: fake-indexeddb clones slowly). */
    private readonly pieceBytes: number = FILE_PIECE_BYTES,
  ) {}

  async isComplete(attachmentId: string): Promise<boolean> {
    return (await this.db.files.get(attachmentId))?.complete ?? false;
  }

  /** Opens a file for writing; with `resume`, after the bytes already stored. */
  async writer(attachmentId: string, size: number, resume = true): Promise<FileWriter> {
    const { db, now, pieceBytes } = this;
    const existing = await db.files.get(attachmentId);
    let stored = 0;
    let index = 0;
    if (existing && resume && existing.size === size && !existing.complete) {
      stored = existing.stored;
      index = await db.fileChunks.where('attachmentId').equals(attachmentId).count();
    } else {
      await this.delete([attachmentId]);
    }
    await db.files.put({ attachmentId, size, stored, complete: false, lastUsedAt: now() });
    let buffer: Uint8Array[] = [];
    let buffered = 0;
    const writePiece = async (piece: Uint8Array) => {
      await db.transaction('rw', db.files, db.fileChunks, async () => {
        await db.fileChunks.put({ attachmentId, index, data: piece });
        await db.files.update(attachmentId, { stored: stored + piece.length, lastUsedAt: now() });
      });
      index++;
      stored += piece.length;
    };
    const flush = async () => {
      if (buffered === 0) return;
      const piece = concat(buffer, buffered);
      buffer = [];
      buffered = 0;
      await writePiece(piece);
    };
    return {
      get stored() {
        return stored + buffered;
      },
      async append(chunk) {
        let offset = 0;
        while (offset < chunk.length) {
          const take = Math.min(pieceBytes - buffered, chunk.length - offset);
          buffer.push(chunk.slice(offset, offset + take));
          buffered += take;
          offset += take;
          if (buffered === pieceBytes) await flush();
        }
      },
      flush,
      async reset() {
        buffer = [];
        buffered = 0;
        await db.transaction('rw', db.files, db.fileChunks, async () => {
          await db.fileChunks.where('attachmentId').equals(attachmentId).delete();
          await db.files.update(attachmentId, { stored: 0 });
        });
        stored = 0;
        index = 0;
      },
      async complete() {
        await flush();
        await db.files.update(attachmentId, { complete: true, lastUsedAt: now() });
      },
    };
  }

  /** The stored bytes in order (marks the file as used). */
  async *read(attachmentId: string): AsyncGenerator<Uint8Array> {
    const { db } = this;
    await db.files.update(attachmentId, { lastUsedAt: this.now() });
    const count = await db.fileChunks.where('attachmentId').equals(attachmentId).count();
    for (let index = 0; index < count; index++) {
      const piece = await db.fileChunks.get([attachmentId, index]);
      if (!piece) return;
      yield piece.data;
    }
  }

  /** Bytes `[start, end)` of a stored file (upload parts). */
  async readRange(attachmentId: string, start: number, end: number): Promise<Uint8Array> {
    const { pieceBytes } = this;
    const out = new Uint8Array(Math.max(0, end - start));
    let filled = 0;
    for (let index = Math.floor(start / pieceBytes); index * pieceBytes < end; index++) {
      const piece = await this.db.fileChunks.get([attachmentId, index]);
      if (!piece) break;
      const pieceStart = index * pieceBytes;
      const from = Math.max(start, pieceStart) - pieceStart;
      const to = Math.min(end, pieceStart + piece.data.length) - pieceStart;
      if (to <= from) continue;
      out.set(piece.data.subarray(from, to), filled);
      filled += to - from;
    }
    if (filled !== out.length) throw new Error('the cached file is incomplete');
    return out;
  }

  async delete(attachmentIds: readonly string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    const { db } = this;
    await db.transaction('rw', db.files, db.fileChunks, async () => {
      await db.fileChunks
        .where('attachmentId')
        .anyOf([...attachmentIds])
        .delete();
      await db.files.bulkDelete([...attachmentIds]);
    });
  }

  /** Files and bytes stored. */
  async usage(): Promise<{ files: number; bytes: number }> {
    const rows = await this.db.files.toArray();
    return { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.stored, 0) };
  }

  /**
   * Deletes least recently used files until the cache holds at most `limitBytes`, never one
   * in `keep` (e.g. a transfer in progress). Returns the bytes freed.
   */
  async evict(limitBytes: number, keep: ReadonlySet<string> = new Set()): Promise<number> {
    const rows = await this.db.files.orderBy('lastUsedAt').toArray();
    let total = rows.reduce((sum, row) => sum + row.stored, 0);
    const drop: string[] = [];
    let freed = 0;
    for (const row of rows) {
      if (total <= limitBytes) break;
      if (keep.has(row.attachmentId)) continue;
      drop.push(row.attachmentId);
      total -= row.stored;
      freed += row.stored;
    }
    await this.delete(drop);
    return freed;
  }

  async clear(keep: ReadonlySet<string> = new Set()): Promise<number> {
    return this.evict(0, keep);
  }
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
