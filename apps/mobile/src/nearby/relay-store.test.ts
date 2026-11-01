// The relay store on SQLite (migration 008) with the real relay store logic on top.
import { describe, expect, it } from 'vitest';

import { migratedDatabase } from '@/db/testing';
import { RelayStore, DEFAULT_MESH_POLICY, type RelayPacketMeta } from '@pingdost/mesh-protocol';

import { SqliteMeshPersistence } from './relay-store';

const NOW = Date.UTC(2026, 10, 1, 12);
const meta = (id: string, overrides: Partial<RelayPacketMeta> = {}): RelayPacketMeta => ({
  id,
  dst: 'aa'.repeat(16),
  origin: 'bb'.repeat(16),
  createdAt: NOW,
  expiresAt: NOW + 60_000,
  hopBudget: 7,
  copies: 4,
  flags: 0,
  size: 3,
  receivedAt: NOW,
  ...overrides,
});

describe('SqliteMeshPersistence', () => {
  it('keeps packets and seen IDs, and clears only the relay cache', async () => {
    const db = await migratedDatabase();
    const persistence = new SqliteMeshPersistence(db, () => NOW);
    await persistence.putPacket(meta('01'), Uint8Array.of(1, 2, 3));
    await persistence.putPacket(meta('02', { receivedAt: NOW + 1 }), Uint8Array.of(4, 5, 6));
    await persistence.updatePacket(meta('01', { copies: 2 }));
    expect((await persistence.loadPackets()).map((m) => [m.id, m.copies])).toEqual([
      ['01', 2],
      ['02', 4],
    ]);
    expect(await persistence.readPayload('02')).toEqual(Uint8Array.of(4, 5, 6));

    await persistence.saveSeen(
      [
        { id: 'x', expiresAt: NOW + 10 },
        { id: 'y', expiresAt: NOW - 1 },
      ],
      [],
    );
    expect(await persistence.loadSeen()).toEqual([{ id: 'x', expiresAt: NOW + 10 }]);

    // The relay store on top: a reload sees the same packets.
    const store = new RelayStore(persistence, DEFAULT_MESH_POLICY);
    await store.load(NOW);
    expect(store.usage()).toEqual({ packets: 2, bytes: 6 });
    await store.remove(['02']);
    expect(await persistence.readPayload('02')).toBeUndefined();

    // Anything else in the database stays (here a setting, standing in for chat rows).
    await db.runAsync("INSERT INTO local_settings (key, value) VALUES ('k', 'v')", []);
    await persistence.clearPackets();
    expect(await persistence.loadPackets()).toEqual([]);
    expect(await db.getAllAsync('SELECT key, value FROM local_settings', [])).toEqual([
      { key: 'k', value: 'v' },
    ]);
  });
});
