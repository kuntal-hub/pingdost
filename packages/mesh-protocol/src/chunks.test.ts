// File chunks over the mesh (ADR 0027): the bitmap, the chunk check, chunk quotas.
import { describe, expect, it } from 'vitest';

import {
  create,
  encodeMeshChunk,
  MeshChunkRefSchema,
  MeshChunkSchema,
  meshChunkDigest,
  meshChunkPacketId,
  PacketKind,
  TransportPacketSchema,
  uuidv7Bytes,
} from '@pingdost/protocol';

import {
  checkMeshChunkPacket,
  ChunkBitmap,
  DEFAULT_MESH_POLICY,
  MemoryMeshPersistence,
  RelayStore,
  type RelayPacketMeta,
} from './index';

const NOW = Date.UTC(2026, 10, 1, 12);

function chunkPacket(options: { data?: Uint8Array; corrupt?: boolean; wrongId?: boolean } = {}) {
  const transferId = uuidv7Bytes();
  const data = options.data ?? Uint8Array.of(1, 2, 3, 4);
  const payload = encodeMeshChunk(
    create(MeshChunkSchema, {
      ref: create(MeshChunkRefSchema, {
        transferId,
        index: 1,
        count: 3,
        chunkSha256: meshChunkDigest(options.corrupt ? Uint8Array.of(9) : data),
      }),
      data,
      originToken: new Uint8Array(16).fill(2),
      signature: new Uint8Array(64).fill(3),
    }),
  );
  return create(TransportPacketSchema, {
    version: 1,
    packetId: options.wrongId ? uuidv7Bytes() : meshChunkPacketId(transferId, 1),
    kind: PacketKind.MESH_CHUNK,
    dst: new Uint8Array(16).fill(1),
    createdAtMs: BigInt(NOW),
    expiresAtMs: BigInt(NOW + 60_000),
    hopBudget: 8,
    copies: 4,
    payload,
  });
}

describe('ChunkBitmap', () => {
  it('tracks held chunks and round-trips its bytes', () => {
    const bitmap = new ChunkBitmap(10);
    expect(bitmap.set(0)).toBe(true);
    expect(bitmap.set(0)).toBe(false);
    bitmap.set(9);
    expect(bitmap.held).toBe(2);
    expect(bitmap.missing(3)).toEqual([1, 2, 3]);
    const copy = new ChunkBitmap(10, bitmap.toBytes());
    expect(copy.has(9)).toBe(true);
    expect(copy.has(5)).toBe(false);
    expect(copy.set(10)).toBe(false);
    for (let i = 0; i < 10; i++) copy.set(i);
    expect(copy.complete).toBe(true);
    expect(() => new ChunkBitmap(0)).toThrow(RangeError);
  });
});

describe('checkMeshChunkPacket', () => {
  it('accepts an intact chunk and drops corrupt or misnamed ones', () => {
    const ok = checkMeshChunkPacket(chunkPacket(), DEFAULT_MESH_POLICY, NOW);
    expect(ok.ok && ok.chunk.ref?.index).toBe(1);
    expect(checkMeshChunkPacket(chunkPacket({ corrupt: true }), DEFAULT_MESH_POLICY, NOW)).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    expect(checkMeshChunkPacket(chunkPacket({ wrongId: true }), DEFAULT_MESH_POLICY, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(checkMeshChunkPacket(chunkPacket(), DEFAULT_MESH_POLICY, NOW + 61_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('RelayStore with chunks', () => {
  const meta = (id: string, kind: 'envelope' | 'chunk'): RelayPacketMeta => ({
    id,
    dst: 'd',
    origin: 'o',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    hopBudget: 7,
    copies: 2,
    flags: 0,
    size: 0,
    receivedAt: NOW,
    kind,
    ...(kind === 'chunk' ? { transfer: 't', index: 0 } : {}),
  });

  it('gives chunks their own per-origin byte budget and no packet count', async () => {
    const store = new RelayStore(new MemoryMeshPersistence(), {
      ...DEFAULT_MESH_POLICY,
      perOriginMaxPackets: 1,
      perOriginMaxBytes: 10,
      perOriginMaxChunkBytes: 30,
    });
    expect(await store.put(meta('e1', 'envelope'), new Uint8Array(5), NOW)).toBe('stored');
    expect(await store.put(meta('e2', 'envelope'), new Uint8Array(5), NOW)).toBe('origin_quota');
    for (const id of ['c1', 'c2', 'c3']) {
      expect(await store.put(meta(id, 'chunk'), new Uint8Array(10), NOW)).toBe('stored');
    }
    expect(await store.put(meta('c4', 'chunk'), new Uint8Array(10), NOW)).toBe('origin_quota');
    expect(store.get('c1')?.transfer).toBe('t');
  });
});
