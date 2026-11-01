// The mesh relay's store on this phone (Phase 23, ADR 0025): other people's encrypted packets
// in `mesh_relay_packets` and the IDs of packets taken in `seen_mesh_packets`, inside the
// SQLCipher database but apart from chat history (REQ §14.3). "Clear relay cache" deletes only
// these rows.
import type { SqlDatabase } from '@/engine/sqlite-store';
import type { MeshPersistence, RelayPacketMeta, SeenEntry } from '@pingdost/mesh-protocol';

interface PacketRow {
  packet_id: string;
  dst: string;
  origin: string;
  created_at: number;
  expires_at: number;
  hop_budget: number;
  copies: number;
  flags: number;
  size: number;
  received_at: number;
}

const toMeta = (r: PacketRow): RelayPacketMeta => ({
  id: r.packet_id,
  dst: r.dst,
  origin: r.origin,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  hopBudget: r.hop_budget,
  copies: r.copies,
  flags: r.flags,
  size: r.size,
  receivedAt: r.received_at,
});

const asBytes = (value: unknown): Uint8Array | undefined =>
  value instanceof Uint8Array
    ? new Uint8Array(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : undefined;

export class SqliteMeshPersistence implements MeshPersistence {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async loadPackets(): Promise<RelayPacketMeta[]> {
    const rows = await this.db.getAllAsync<PacketRow>(
      `SELECT packet_id, dst, origin, created_at, expires_at, hop_budget, copies, flags, size,
              received_at
         FROM mesh_relay_packets ORDER BY received_at`,
      [],
    );
    return rows.map(toMeta);
  }

  async readPayload(id: string): Promise<Uint8Array | undefined> {
    const row = await this.db.getFirstAsync<{ payload: unknown }>(
      'SELECT payload FROM mesh_relay_packets WHERE packet_id = ?',
      [id],
    );
    return row ? asBytes(row.payload) : undefined;
  }

  async putPacket(meta: RelayPacketMeta, payload: Uint8Array): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO mesh_relay_packets
         (packet_id, dst, origin, created_at, expires_at, hop_budget, copies, flags, size,
          received_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        meta.id,
        meta.dst,
        meta.origin,
        meta.createdAt,
        meta.expiresAt,
        meta.hopBudget,
        meta.copies,
        meta.flags,
        meta.size,
        meta.receivedAt,
        payload,
      ],
    );
  }

  async updatePacket(meta: RelayPacketMeta): Promise<void> {
    await this.db.runAsync('UPDATE mesh_relay_packets SET copies = ? WHERE packet_id = ?', [
      meta.copies,
      meta.id,
    ]);
  }

  async deletePackets(ids: readonly string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += 200) {
      const chunk = ids.slice(start, start + 200);
      await this.db.runAsync(
        `DELETE FROM mesh_relay_packets WHERE packet_id IN (${chunk.map(() => '?').join(', ')})`,
        [...chunk],
      );
    }
  }

  async clearPackets(): Promise<void> {
    await this.db.runAsync('DELETE FROM mesh_relay_packets', []);
  }

  async loadSeen(): Promise<SeenEntry[]> {
    const rows = await this.db.getAllAsync<{ packet_id: string; expires_at: number }>(
      'SELECT packet_id, expires_at FROM seen_mesh_packets WHERE expires_at > ?',
      [this.now()],
    );
    return rows.map((r) => ({ id: r.packet_id, expiresAt: r.expires_at }));
  }

  async saveSeen(add: readonly SeenEntry[], remove: readonly string[]): Promise<void> {
    const now = this.now();
    for (const id of remove) {
      await this.db.runAsync('DELETE FROM seen_mesh_packets WHERE packet_id = ?', [id]);
    }
    for (const entry of add) {
      await this.db.runAsync(
        `INSERT OR REPLACE INTO seen_mesh_packets (packet_id, seen_at, expires_at)
         VALUES (?, ?, ?)`,
        [entry.id, now, entry.expiresAt],
      );
    }
    await this.db.runAsync('DELETE FROM seen_mesh_packets WHERE expires_at <= ?', [now]);
  }
}
