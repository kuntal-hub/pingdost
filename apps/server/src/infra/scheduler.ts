/**
 * Interval jobs with a Mongo lease (ARCHITECTURE A2: no BullMQ/QStash). Each run first takes
 * the `job_locks` document for the job; another process holding an unexpired lease makes
 * this one skip the run. Jobs must be idempotent and safe to retry.
 */
import { randomUUID } from 'node:crypto';

import type { Collection, Db } from 'mongodb';
import type { Logger } from 'pino';

import { systemClock, type Clock } from './clock';
import { duplicateKeyField, type IndexSetup } from './mongo';

export interface Job {
  name: string;
  intervalMs: number;
  /** How long a run may hold the lease; default `intervalMs`. */
  leaseMs?: number;
  run(signal: AbortSignal): Promise<void>;
}

interface JobLockDoc {
  _id: string;
  owner: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export interface SchedulerOptions {
  /** Identifies this process in `job_locks`; default a random UUID. */
  owner?: string;
  /** Random spread of each interval, as a fraction (default 0.1 = ±10%). */
  jitter?: number;
  clock?: Clock;
}

export const schedulerIndexes: IndexSetup = async (db) => {
  await db.collection<JobLockDoc>('job_locks').createIndex({ expiresAt: 1 });
};

export class Scheduler {
  readonly owner: string;
  readonly #locks: Collection<JobLockDoc>;
  readonly #log: Logger;
  readonly #jitter: number;
  readonly #clock: Clock;
  readonly #jobs: Job[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #running = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #started = false;

  constructor(db: Db, log: Logger, options: SchedulerOptions = {}) {
    this.owner = options.owner ?? randomUUID();
    this.#locks = db.collection<JobLockDoc>('job_locks');
    this.#log = log.child({ component: 'scheduler' });
    this.#jitter = options.jitter ?? 0.1;
    this.#clock = options.clock ?? systemClock;
  }

  register(job: Job): this {
    this.#jobs.push(job);
    return this;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const job of this.#jobs) this.#schedule(job);
    this.#log.info({ jobs: this.#jobs.map((job) => job.name) }, 'scheduler started');
  }

  /** Stops scheduling, aborts running jobs and waits up to `timeoutMs` for them. */
  async stop(timeoutMs = 10_000): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#abort.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.#running]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** One leased run of `job`. Resolves false when another owner holds the lease. */
  async runOnce(job: Job): Promise<boolean> {
    if (!(await this.#acquire(job))) return false;
    const started = this.#clock.now();
    try {
      await job.run(this.#abort.signal);
      this.#log.debug({ job: job.name, ms: this.#clock.now() - started }, 'job done');
    } catch (error) {
      this.#log.error({ job: job.name, err: error }, 'job failed');
    } finally {
      await this.#release(job).catch((error: unknown) =>
        this.#log.warn({ job: job.name, err: error }, 'lease release failed'),
      );
    }
    return true;
  }

  #schedule(job: Job): void {
    if (this.#abort.signal.aborted) return;
    const spread = 1 + (Math.random() * 2 - 1) * this.#jitter;
    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        const run = this.runOnce(job)
          .catch((error: unknown) => this.#log.error({ job: job.name, err: error }, 'lease failed'))
          .finally(() => {
            this.#running.delete(run);
            this.#schedule(job);
          });
        this.#running.add(run);
      },
      Math.round(job.intervalMs * spread),
    );
    timer.unref();
    this.#timers.add(timer);
  }

  async #acquire(job: Job): Promise<boolean> {
    const now = this.#clock.now();
    try {
      const lock = await this.#locks.findOneAndUpdate(
        { _id: job.name, $or: [{ expiresAt: { $lte: new Date(now) } }, { owner: this.owner }] },
        {
          $set: {
            owner: this.owner,
            acquiredAt: new Date(now),
            expiresAt: new Date(now + (job.leaseMs ?? job.intervalMs)),
          },
        },
        { upsert: true, returnDocument: 'after' },
      );
      return lock !== null;
    } catch (error) {
      // The upsert collided with a lease another owner still holds.
      if (duplicateKeyField(error) !== undefined) return false;
      throw error;
    }
  }

  async #release(job: Job): Promise<void> {
    await this.#locks.updateOne(
      { _id: job.name, owner: this.owner },
      { $set: { expiresAt: new Date(this.#clock.now()) } },
    );
  }
}
