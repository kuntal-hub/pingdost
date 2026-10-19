/**
 * Mailbox jobs (REQ §9.2–9.3, ARCHITECTURE A3).
 * - Migration: due envelopes move from the Redis stage to Mongo. The Redis copy is dropped
 *   only after the Mongo write is verified, so a failure at any step leaves at least one
 *   copy. It also drops `due` entries whose record is gone and expires envelopes whose
 *   absolute expiry came before their stage ended.
 * - Reaper: deletes expired Mongo envelopes even if the TTL monitor is late. Redis needs no
 *   sweep: every staged envelope is in `due`, so the migration reaches it, and fetches drop
 *   `mbx` entries whose record expired.
 */
import type { Logger } from 'pino';

import type { MongoMailboxStore } from './mongo-store';
import type { EnvelopeRecord } from './record';
import type { RedisMailbox } from './redis-store';
import type { MailboxSettings } from './settings';
import type { Clock } from '../../infra/clock';
import type { Metrics } from '../../infra/metrics';
import type { Job } from '../../infra/scheduler';

export interface MailboxJobDeps {
  settings: MailboxSettings;
  clock: Clock;
  metrics: Metrics;
  log: Logger;
  redis: RedisMailbox;
  mongo: MongoMailboxStore;
}

export interface MigrationResult {
  migrated: number;
  /** Envelopes whose Mongo write failed; their Redis copy stays for the next run. */
  failed: number;
  /** `due` entries whose record was already gone (acknowledged). */
  dropped: number;
  /** Envelopes past their absolute expiry, deleted instead of migrated. */
  expired: number;
}

/** Attempts per envelope within one run; the next run retries again. */
const WRITE_ATTEMPTS = 3;
const RETRY_BASE_MS = 200;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class MailboxMigrator {
  constructor(private readonly d: MailboxJobDeps) {}

  /** One pass over the due envelopes (bounded by `migrationBatchSize`). */
  async runOnce(signal?: AbortSignal): Promise<MigrationResult> {
    const { settings, redis, metrics } = this.d;
    const now = this.d.clock.now();
    const result: MigrationResult = { migrated: 0, failed: 0, dropped: 0, expired: 0 };

    for (const { envelopeId } of await redis.due(now, settings.migrationBatchSize)) {
      if (signal?.aborted) break;
      if (!(await redis.lock(envelopeId, settings.migrationLockMs))) continue;
      const record = await redis.get(envelopeId);
      if (!record) {
        await redis.dropDue([envelopeId]);
        result.dropped++;
        continue;
      }
      if (record.expiresAt <= now) {
        await redis.unstage(record);
        metrics.expiredDeleted.inc({ store: 'redis' });
        result.expired++;
        continue;
      }
      if (!(await this.#writeVerified(record, now, signal))) {
        result.failed++;
        metrics.migrationFailures.inc();
        // Mongo is probably down: release the lock so the next run retries at once, and
        // stop this run instead of failing every envelope.
        await redis.unlock(envelopeId).catch(() => undefined);
        break;
      }
      if (!(await redis.unstage(record))) {
        // An ACK deleted the Redis copy while this ran: the recipient has the envelope, so
        // the copy just written to Mongo must go too.
        await this.d.mongo.removeOne(envelopeId);
      }
      metrics.migrations.inc();
      result.migrated++;
    }

    await this.#recordStage(now);
    return result;
  }

  /** Writes to Mongo and reads it back, with bounded retries. */
  async #writeVerified(
    record: EnvelopeRecord,
    now: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      try {
        await this.d.mongo.insert(record, now);
        if (await this.d.mongo.has(record.envelopeId)) return true;
        throw new Error('the migrated envelope is not readable');
      } catch (error) {
        this.d.log.warn(
          { err: error, envelopeId: record.envelopeId, attempt },
          'mailbox: migration write failed; the Redis copy stays',
        );
        if (attempt < WRITE_ATTEMPTS) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
      }
    }
    return false;
  }

  async #recordStage(now: number): Promise<void> {
    const { settings } = this.d;
    try {
      // Overdue = due for over half the grace period: the alert fires while the Redis copy
      // still exists (its safety TTL ends a full grace period after the due time).
      const snapshot = await this.d.redis.snapshot(now, now - settings.graceMs / 2);
      // The due score is createdAt + STAGE (earlier only for short-lived packets).
      const oldestCreatedAt =
        snapshot.oldestDueAt === null ? now : snapshot.oldestDueAt - settings.stageMs;
      this.d.metrics.recordStage({
        stageCount: snapshot.count,
        oldestAgeSeconds: Math.max(0, (now - oldestCreatedAt) / 1000),
        dueBacklog: snapshot.due,
        overdue: snapshot.overdue,
      });
      if (snapshot.overdue > 0) {
        this.d.log.error(
          { overdue: snapshot.overdue },
          'mailbox: envelopes are overdue for migration; the Redis safety TTL may delete them',
        );
      }
    } catch (error) {
      this.d.log.warn({ err: error }, 'mailbox: stage snapshot failed');
    }
  }
}

export class MailboxReaper {
  constructor(private readonly d: MailboxJobDeps) {}

  async runOnce(): Promise<number> {
    const deleted = await this.d.mongo.removeExpired(this.d.clock.now());
    this.d.metrics.expiredDeleted.inc({ store: 'mongo' }, deleted);
    return deleted;
  }
}

/** The scheduler jobs; each run holds a Mongo lease (one runner across processes). */
export function mailboxJobs(deps: MailboxJobDeps): Job[] {
  const migrator = new MailboxMigrator(deps);
  const reaper = new MailboxReaper(deps);
  return [
    {
      name: 'mailbox-migration',
      intervalMs: deps.settings.migrationPollMs,
      run: async (signal) => {
        await migrator.runOnce(signal);
      },
    },
    {
      name: 'mailbox-reaper',
      intervalMs: deps.settings.reaperIntervalMs,
      run: async () => {
        await reaper.runOnce();
      },
    },
  ];
}
