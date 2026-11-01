// The relay's building blocks (ADR 0025): checks, spray split, seen-cache, store and rates.
import { describe, expect, it } from 'vitest';

import {
  create,
  CryptoType,
  encodeMeshEnvelope,
  MeshEnvelopeSchema,
  PacketKind,
  TransportPacketSchema,
  uuidv7Bytes,
  type TransportPacket,
} from '@pingdost/protocol';

import {
  checkMeshPacket,
  DEFAULT_MESH_POLICY,
  fromHex,
  MemoryMeshPersistence,
  meshPolicy,
  RateLimiter,
  RelayStore,
  SeenCache,
  splitCopies,
  toHex,
  type RelayPacketMeta,
} from './index';

const NOW = Date.UTC(2026, 10, 1, 12);
const MIN = 60_000;

function packet(overrides: Partial<Omit<TransportPacket, '$typeName' | '$unknown'>> = {}) {
  return create(TransportPacketSchema, {
    version: 1,
    packetId: uuidv7Bytes(),
    kind: PacketKind.MESH_ENVELOPE,
    dst: new Uint8Array(16).fill(1),
    createdAtMs: BigInt(NOW),
    expiresAtMs: BigInt(NOW + 60 * MIN),
    hopBudget: 8,
    copies: 8,
    payload: encodeMeshEnvelope(
      create(MeshEnvelopeSchema, {
        originToken: new Uint8Array(16).fill(2),
        envelopeId: uuidv7Bytes(),
        cryptoType: CryptoType.OLM,
        ciphertext: Uint8Array.of(1, 2, 3),
        signature: new Uint8Array(64).fill(3),
      }),
    ),
    ...overrides,
  });
}

describe('checkMeshPacket', () => {
  it('accepts a good packet and decodes its envelope', () => {
    const result = checkMeshPacket(packet(), DEFAULT_MESH_POLICY, NOW);
    expect(result.ok && result.envelope.cryptoType).toBe(CryptoType.OLM);
  });

  it('drops expired, over-hop, future, over-long, bad-copy and malformed packets', () => {
    const cases: [Parameters<typeof packet>[0], string][] = [
      [{ expiresAtMs: BigInt(NOW - 1) }, 'expired'],
      [{ hopBudget: DEFAULT_MESH_POLICY.maxHops + 1 }, 'over_budget'],
      [{ createdAtMs: BigInt(NOW + 11 * MIN), expiresAtMs: BigInt(NOW + 60 * MIN) }, 'from_future'],
      [
        {
          createdAtMs: BigInt(NOW),
          expiresAtMs: BigInt(NOW + DEFAULT_MESH_POLICY.ttlMs + 11 * MIN),
        },
        'ttl_too_long',
      ],
      [{ copies: 0 }, 'bad_copies'],
      [{ copies: DEFAULT_MESH_POLICY.maxCopies + 1 }, 'bad_copies'],
      [{ dst: new Uint8Array(15) }, 'malformed'],
      [{ payload: Uint8Array.of(0xff, 0xff) }, 'malformed'],
      [{ kind: PacketKind.ENVELOPE }, 'wrong_kind'],
    ];
    for (const [overrides, reason] of cases) {
      expect(checkMeshPacket(packet(overrides), DEFAULT_MESH_POLICY, NOW)).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it('splits copies for binary spray-and-wait', () => {
    expect(splitCopies(8)).toEqual({ give: 4, keep: 4 });
    expect(splitCopies(3)).toEqual({ give: 1, keep: 2 });
    expect(splitCopies(1)).toEqual({ give: 0, keep: 1 });
    expect(toHex(fromHex('00ff10'))).toBe('00ff10');
  });

  it('checks policy overrides', () => {
    expect(meshPolicy({ maxHops: 3 }).maxHops).toBe(3);
    expect(() => meshPolicy({ maxHops: 0 })).toThrow(RangeError);
    expect(() => meshPolicy({ maxHops: 33 })).toThrow(RangeError);
    expect(() => meshPolicy({ storageLimitBytes: 0 })).toThrow(RangeError);
    expect(() => meshPolicy({ sprayCopies: 100 })).toThrow(RangeError);
  });
});

describe('SeenCache', () => {
  it('remembers IDs until they expire, evicting the least recently used past its size', () => {
    const seen = new SeenCache(2);
    seen.add('a', NOW + MIN);
    seen.add('b', NOW + MIN);
    expect(seen.has('a', NOW)).toBe(true); // a is now the most recent
    expect(seen.add('c', NOW + MIN)).toEqual(['b']);
    expect(seen.has('b', NOW)).toBe(false);
    expect(seen.has('a', NOW + MIN)).toBe(false); // expired
    seen.load(
      [
        { id: 'x', expiresAt: NOW - 1 },
        { id: 'y', expiresAt: NOW + MIN },
      ],
      NOW,
    );
    expect(seen.has('x', NOW)).toBe(false);
    expect(seen.prune(NOW + 2 * MIN).length).toBeGreaterThan(0);
    expect(seen.size).toBe(0);
  });
});

describe('RelayStore', () => {
  const meta = (id: string, overrides: Partial<RelayPacketMeta> = {}): RelayPacketMeta => ({
    id,
    dst: 'd',
    origin: 'o',
    createdAt: NOW,
    expiresAt: NOW + 60 * MIN,
    hopBudget: 7,
    copies: 4,
    flags: 0,
    size: 0,
    receivedAt: NOW,
    ...overrides,
  });
  const store = (policy: Partial<typeof DEFAULT_MESH_POLICY> = {}) => {
    const persistence = new MemoryMeshPersistence();
    return {
      persistence,
      store: new RelayStore(persistence, { ...DEFAULT_MESH_POLICY, ...policy }),
    };
  };

  it('stores, refuses duplicates, counts bytes and persists', async () => {
    const { store: relay, persistence } = store();
    expect(await relay.put(meta('a'), new Uint8Array(10), NOW)).toBe('stored');
    expect(await relay.put(meta('a'), new Uint8Array(10), NOW)).toBe('duplicate');
    expect(relay.usage()).toEqual({ packets: 1, bytes: 10 });
    expect(persistence.packets.get('a')?.meta.size).toBe(10);
    await relay.setCopies('a', 2);
    expect(persistence.packets.get('a')?.meta.copies).toBe(2);
    const reloaded = new RelayStore(persistence, DEFAULT_MESH_POLICY);
    await reloaded.load(NOW);
    expect(reloaded.get('a')?.copies).toBe(2);
  });

  it('enforces the byte cap: expired first, then the oldest received', async () => {
    const { store: relay } = store({ storageLimitBytes: 30 });
    await relay.put(meta('old', { receivedAt: NOW - 3 }), new Uint8Array(10), NOW);
    await relay.put(
      meta('expired', { receivedAt: NOW - 1, expiresAt: NOW + 1, origin: 'p' }),
      new Uint8Array(10),
      NOW,
    );
    await relay.put(meta('mid', { receivedAt: NOW - 2, origin: 'q' }), new Uint8Array(10), NOW);
    expect(await relay.put(meta('new', { origin: 'r' }), new Uint8Array(10), NOW + 2)).toBe(
      'stored',
    );
    expect(relay.has('expired')).toBe(false);
    expect(relay.has('old')).toBe(true);
    expect(await relay.put(meta('newer', { origin: 's' }), new Uint8Array(10), NOW + 2)).toBe(
      'stored',
    );
    expect(relay.has('old')).toBe(false);
    expect(relay.usage().bytes).toBeLessThanOrEqual(30);
    expect(await relay.put(meta('huge', { origin: 't' }), new Uint8Array(31), NOW)).toBe(
      'too_large',
    );
  });

  it('enforces per-origin quotas without pushing other origins out', async () => {
    const { store: relay } = store({ perOriginMaxPackets: 2, perOriginMaxBytes: 1_000 });
    await relay.put(meta('1'), new Uint8Array(1), NOW);
    await relay.put(meta('2'), new Uint8Array(1), NOW);
    expect(await relay.put(meta('3'), new Uint8Array(1), NOW)).toBe('origin_quota');
    expect(await relay.put(meta('4', { origin: 'other' }), new Uint8Array(1), NOW)).toBe('stored');
    const bytes = store({ perOriginMaxBytes: 15 });
    await bytes.store.put(meta('a'), new Uint8Array(10), NOW);
    expect(await bytes.store.put(meta('b'), new Uint8Array(10), NOW)).toBe('origin_quota');
  });

  it('clears and prunes without touching anything else', async () => {
    const { store: relay, persistence } = store();
    await relay.put(meta('a', { expiresAt: NOW + 1 }), new Uint8Array(4), NOW);
    await relay.put(meta('b'), new Uint8Array(4), NOW);
    expect(await relay.prune(NOW + 1)).toEqual(['a']);
    await relay.clear();
    expect(relay.usage()).toEqual({ packets: 0, bytes: 0 });
    expect(persistence.packets.size).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then the sustained rate, per key', () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 2 });
    expect(limiter.take('a', NOW)).toBe(true);
    expect(limiter.take('a', NOW)).toBe(true);
    expect(limiter.take('a', NOW)).toBe(false);
    expect(limiter.take('b', NOW)).toBe(true);
    expect(limiter.take('a', NOW + 1_000)).toBe(true);
    expect(limiter.take('a', NOW + 1_000)).toBe(false);
  });

  it('keeps a bounded number of keys', () => {
    const limiter = new RateLimiter({ perMinute: 1, burst: 1 }, 2);
    limiter.take('a', NOW);
    limiter.take('b', NOW);
    limiter.take('c', NOW); // 'a' is forgotten
    expect(limiter.take('a', NOW)).toBe(true);
  });
});
