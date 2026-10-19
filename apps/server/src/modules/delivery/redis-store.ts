/**
 * The Redis hot stage (ARCHITECTURE A3). Keys, under the configured prefix:
 * - `env:{envelopeId}`: the record, with a safety TTL of STAGE + GRACE;
 * - `mbx:{recipientDeviceId}`: a ZSET of envelope IDs scored by createdAt;
 * - `due`: a ZSET of envelope IDs scored by the time they must move to Mongo;
 * - `lock:{envelopeId}`: the migration lease.
 * Upstash bills every command, so each operation uses as few as it can (ADR 0010).
 */
import { decodeRecord, encodeRecord, type EnvelopeRecord } from './record';
import type { RedisHandle } from '../../infra/redis';

export interface StagedBatch {
  records: EnvelopeRecord[];
  /** IDs listed for the device whose record is gone (expired); already unlisted. */
  orphans: string[];
}

export interface DueEntry {
  envelopeId: string;
  dueAt: number;
}

function check(results: [Error | null, unknown][] | null): unknown[] {
  if (!results) throw new Error('redis transaction aborted');
  return results.map(([error, value]) => {
    if (error) throw error;
    return value;
  });
}

export class RedisMailbox {
  constructor(
    private readonly redis: RedisHandle,
    private readonly prefix: string,
  ) {}

  #env(id: string): string {
    return `${this.prefix}env:${id}`;
  }
  #mbx(deviceId: string): string {
    return `${this.prefix}mbx:${deviceId}`;
  }
  get #due(): string {
    return `${this.prefix}due`;
  }
  #lock(id: string): string {
    return `${this.prefix}lock:${id}`;
  }

  /**
   * Stages a new envelope in one MULTI. False when the ID was already staged, in which case
   * nothing changes (every write is NX).
   */
  async store(record: EnvelopeRecord, dueAt: number, safetyTtlMs: number): Promise<boolean> {
    const [set] = check(
      await this.redis
        .client()
        .multi()
        .set(this.#env(record.envelopeId), encodeRecord(record), 'PX', safetyTtlMs, 'NX')
        .zadd(this.#mbx(record.recipientDeviceId), 'NX', record.createdAt, record.envelopeId)
        .zadd(this.#due, 'NX', dueAt, record.envelopeId)
        .exec(),
    );
    return set === 'OK';
  }

  async get(envelopeId: string): Promise<EnvelopeRecord | null> {
    const value = await this.redis.client().get(this.#env(envelopeId));
    return value === null ? null : decodeRecord(envelopeId, value);
  }

  /** The device's oldest staged envelopes; IDs whose record expired are unlisted. */
  async list(deviceId: string, limit: number): Promise<StagedBatch> {
    const client = this.redis.client();
    const ids = await client.zrange(this.#mbx(deviceId), 0, String(limit - 1));
    if (ids.length === 0) return { records: [], orphans: [] };
    const values = await client.mget(...ids.map((id) => this.#env(id)));
    const records: EnvelopeRecord[] = [];
    const orphans: string[] = [];
    ids.forEach((id, index) => {
      const value = values[index];
      if (value) records.push(decodeRecord(id, value));
      else orphans.push(id);
    });
    if (orphans.length > 0) await client.zrem(this.#mbx(deviceId), ...orphans);
    return { records, orphans };
  }

  /**
   * Removes the device's envelopes among `ids` (an ACK). IDs not listed for this device are
   * ignored, so a device can only delete its own mail. Returns the removed IDs.
   */
  async remove(deviceId: string, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const client = this.redis.client();
    const scores = await client.zmscore(this.#mbx(deviceId), ...ids);
    const listed = ids.filter((_, index) => scores[index] !== null);
    if (listed.length === 0) return [];
    check(
      await client
        .multi()
        .del(...listed.map((id) => this.#env(id)))
        .zrem(this.#mbx(deviceId), ...listed)
        .zrem(this.#due, ...listed)
        .exec(),
    );
    return listed;
  }

  /**
   * The migration's final step: one MULTI that drops the staged copy. Resolves false when
   * the record was already gone, i.e. an ACK raced the migration.
   */
  async unstage(record: EnvelopeRecord): Promise<boolean> {
    const [deleted] = check(
      await this.redis
        .client()
        .multi()
        .del(this.#env(record.envelopeId))
        .zrem(this.#mbx(record.recipientDeviceId), record.envelopeId)
        .zrem(this.#due, record.envelopeId)
        .exec(),
    );
    return deleted === 1;
  }

  /** Envelopes due for migration at `now`, oldest first. */
  async due(now: number, limit: number): Promise<DueEntry[]> {
    const flat = await this.redis
      .client()
      .zrangebyscore(this.#due, '-inf', now, 'WITHSCORES', 'LIMIT', 0, limit);
    const entries: DueEntry[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      entries.push({ envelopeId: flat[i] as string, dueAt: Number(flat[i + 1]) });
    }
    return entries;
  }

  /** Drops IDs from `due` whose record is gone (acknowledged or expired). */
  async dropDue(ids: readonly string[]): Promise<void> {
    if (ids.length > 0) await this.redis.client().zrem(this.#due, ...ids);
  }

  /** Takes the per-envelope migration lease. */
  async lock(envelopeId: string, ms: number): Promise<boolean> {
    const set = await this.redis.client().set(this.#lock(envelopeId), '1', 'PX', ms, 'NX');
    return set === 'OK';
  }

  async unlock(envelopeId: string): Promise<void> {
    await this.redis.client().del(this.#lock(envelopeId));
  }

  /**
   * Stage size, oldest due time, due backlog and overdue count: four commands, once per
   * migration run.
   */
  async snapshot(
    now: number,
    overdueBefore: number,
  ): Promise<{ count: number; oldestDueAt: number | null; due: number; overdue: number }> {
    // A pipeline, not MULTI: the reads need no atomicity, and MULTI/EXEC would cost two more.
    const results = check(
      await this.redis
        .client()
        .pipeline()
        .zcard(this.#due)
        .zrange(this.#due, '0', '0', 'WITHSCORES')
        .zcount(this.#due, '-inf', now)
        .zcount(this.#due, '-inf', overdueBefore)
        .exec(),
    );
    const oldest = results[1] as string[];
    return {
      count: Number(results[0]),
      oldestDueAt: oldest.length === 2 ? Number(oldest[1]) : null,
      due: Number(results[2]),
      overdue: Number(results[3]),
    };
  }
}
