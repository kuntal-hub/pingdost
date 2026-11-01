/**
 * Relay limits (REQ §11.4, ADR 0025). The hop, TTL and storage defaults are REQ §17's
 * `MESH_PACKET_MAX_HOPS`, `MESH_PACKET_TTL_SECONDS` and `MESH_RELAY_STORAGE_LIMIT_BYTES`; the
 * rest are starting values for testing, not protocol constants. Every value is configurable.
 */
import { DEFAULT_LIMITS, MESH_PACKET_MAX_HOPS_RANGE } from '@pingdost/config/public';

export interface Rate {
  /** Sustained events per minute. */
  perMinute: number;
  /** How many may come at once. */
  burst: number;
}

export interface MeshPolicy {
  /** Hop budget of a new packet, and the most a relay accepts. */
  maxHops: number;
  /** A relayed packet expires at most this long after it was made. */
  ttlMs: number;
  /** Bytes of other people's packets this device keeps. */
  storageLimitBytes: number;
  /** Copies of a new packet (binary spray-and-wait). */
  sprayCopies: number;
  /** The most copies a relay accepts on one packet. */
  maxCopies: number;
  /** A packet may claim to be made this far in the future (clock skew). */
  clockSkewMs: number;
  /** Stored packets from one origin token. */
  perOriginMaxPackets: number;
  /** Stored bytes from one origin token. */
  perOriginMaxBytes: number;
  /** Packet IDs remembered to refuse duplicates (LRU, also bounded by expiry). */
  seenCacheMax: number;
  /** Delivered packet IDs remembered and passed on, so holders drop their copies. */
  deliveredMax: number;
  /** No answer to an offered packet in this long: try it elsewhere. */
  ackTimeoutMs: number;
  /** Copies of each file chunk (ADR 0027): fewer than messages, chunks are big. */
  chunkCopies: number;
  /** Stored file-chunk bytes from one origin token: room for one 100 MB file. */
  perOriginMaxChunkBytes: number;
  rates: {
    /** File chunks taken from one neighbour. */
    chunkPerPeer: Rate;
    /** Own packets handed to the mesh. */
    create: Rate;
    /** Packets taken from one neighbour. */
    relayPerPeer: Rate;
    /** Packets taken from one origin token, from any neighbour. */
    relayPerOrigin: Rate;
    /** Summaries (routing tokens, delivered IDs) taken from one neighbour. */
    summaryPerPeer: Rate;
  };
}

export const DEFAULT_MESH_POLICY: MeshPolicy = {
  maxHops: DEFAULT_LIMITS.meshPacketMaxHops,
  ttlMs: DEFAULT_LIMITS.meshPacketTtlSeconds * 1000,
  storageLimitBytes: DEFAULT_LIMITS.meshRelayStorageLimitBytes,
  sprayCopies: 8,
  maxCopies: 64,
  clockSkewMs: 10 * 60_000,
  perOriginMaxPackets: 1_000,
  perOriginMaxBytes: 25 * 1_048_576,
  seenCacheMax: 20_000,
  deliveredMax: 256,
  ackTimeoutMs: 15_000,
  chunkCopies: 4,
  perOriginMaxChunkBytes: 110 * 1_048_576,
  rates: {
    chunkPerPeer: { perMinute: 600, burst: 300 },
    create: { perMinute: 120, burst: 120 },
    relayPerPeer: { perMinute: 120, burst: 60 },
    relayPerOrigin: { perMinute: 60, burst: 60 },
    summaryPerPeer: { perMinute: 6, burst: 3 },
  },
};

/** The defaults with `overrides`, checked: a bad value throws. */
export function meshPolicy(overrides: Partial<MeshPolicy> = {}): MeshPolicy {
  const policy: MeshPolicy = {
    ...DEFAULT_MESH_POLICY,
    ...overrides,
    rates: { ...DEFAULT_MESH_POLICY.rates, ...overrides.rates },
  };
  const { min, max } = MESH_PACKET_MAX_HOPS_RANGE;
  if (!Number.isInteger(policy.maxHops) || policy.maxHops < min || policy.maxHops > max) {
    throw new RangeError(`maxHops must be ${min}..${max}`);
  }
  for (const key of [
    'ttlMs',
    'storageLimitBytes',
    'sprayCopies',
    'maxCopies',
    'perOriginMaxPackets',
    'perOriginMaxBytes',
    'seenCacheMax',
    'deliveredMax',
    'ackTimeoutMs',
    'chunkCopies',
    'perOriginMaxChunkBytes',
  ] as const) {
    if (!(policy[key] > 0)) throw new RangeError(`${key} must be positive`);
  }
  if (policy.sprayCopies > policy.maxCopies) throw new RangeError('sprayCopies > maxCopies');
  if (policy.chunkCopies > policy.maxCopies) throw new RangeError('chunkCopies > maxCopies');
  return policy;
}
