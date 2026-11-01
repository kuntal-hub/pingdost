// Incoming mesh file chunks in SQLite (Phase 24, ADR 0027): migration 009's `mesh_incoming` and
// `mesh_incoming_chunks`, apart from chats. Ciphertext only; deleted once the file is assembled.
import type { SqlDatabase } from '@/engine/sqlite-store';
import type { MeshChunkStorage } from '@pingdost/attachments';

/** Incoming chunks in the database, apart from chats; deleted once the file is assembled. */
export class SqliteChunkStorage implements MeshChunkStorage {
  constructor(private readonly db: SqlDatabase) {}

  async put(transferId: string, index: number, data: Uint8Array): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO mesh_incoming_chunks (transfer_id, chunk_index, data)
       VALUES (?, ?, ?)`,
      [transferId, index, data],
    );
  }

  async get(transferId: string, index: number): Promise<Uint8Array | undefined> {
    const row = await this.db.getFirstAsync<{ data: Uint8Array }>(
      'SELECT data FROM mesh_incoming_chunks WHERE transfer_id = ? AND chunk_index = ?',
      [transferId, index],
    );
    return row ? new Uint8Array(row.data) : undefined;
  }

  async load(): Promise<{ transferId: string; count: number; indices: number[] }[]> {
    const transfers = await this.db.getAllAsync<{ transfer_id: string; chunk_count: number }>(
      'SELECT transfer_id, chunk_count FROM mesh_incoming',
      [],
    );
    const out: { transferId: string; count: number; indices: number[] }[] = [];
    for (const t of transfers) {
      const rows = await this.db.getAllAsync<{ chunk_index: number }>(
        'SELECT chunk_index FROM mesh_incoming_chunks WHERE transfer_id = ?',
        [t.transfer_id],
      );
      out.push({
        transferId: t.transfer_id,
        count: t.chunk_count,
        indices: rows.map((r) => r.chunk_index),
      });
    }
    return out;
  }

  async begin(transferId: string, count: number): Promise<void> {
    await this.db.runAsync(
      `INSERT OR IGNORE INTO mesh_incoming (transfer_id, chunk_count, created_at)
       VALUES (?, ?, ?)`,
      [transferId, count, Date.now()],
    );
  }

  async remove(transferId: string): Promise<void> {
    await this.db.runAsync('DELETE FROM mesh_incoming_chunks WHERE transfer_id = ?', [transferId]);
    await this.db.runAsync('DELETE FROM mesh_incoming WHERE transfer_id = ?', [transferId]);
  }
}
