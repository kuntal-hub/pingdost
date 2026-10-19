/** The Mongo-leased job scheduler: one runner at a time, graceful stop. */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../src/infra/logger';
import { createMongo, ensureIndexes, type Mongo } from '../src/infra/mongo';
import { Scheduler, schedulerIndexes, type Job } from '../src/infra/scheduler';

let mongo: Mongo;
const log = createLogger({ level: 'silent' });

beforeAll(async () => {
  mongo = createMongo(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0', {
    dbName: `pingdost_test_${randomUUID().slice(0, 8)}`,
  });
  await ensureIndexes(mongo.db, [schedulerIndexes]);
});

afterAll(async () => {
  await mongo.db.dropDatabase();
  await mongo.close();
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('Scheduler', () => {
  it('lets only one owner run a job at a time', async () => {
    const a = new Scheduler(mongo.db, log, { owner: 'a' });
    const b = new Scheduler(mongo.db, log, { owner: 'b' });
    const gate = deferred();
    const runs: string[] = [];
    const job = (owner: string): Job => ({
      name: 'exclusive',
      intervalMs: 60_000,
      run: async () => {
        runs.push(owner);
        if (owner === 'a') await gate.promise;
      },
    });

    const first = a.runOnce(job('a'));
    await expect.poll(() => runs).toEqual(['a']);
    expect(await b.runOnce(job('b'))).toBe(false);

    gate.resolve();
    expect(await first).toBe(true);
    expect(await b.runOnce(job('b'))).toBe(true);
    expect(runs).toEqual(['a', 'b']);
  });

  it('keeps running after a job fails', async () => {
    const scheduler = new Scheduler(mongo.db, log);
    let calls = 0;
    const failing: Job = {
      name: 'failing',
      intervalMs: 60_000,
      run: () => {
        calls++;
        return Promise.reject(new Error('boom'));
      },
    };
    expect(await scheduler.runOnce(failing)).toBe(true);
    expect(await scheduler.runOnce(failing)).toBe(true);
    expect(calls).toBe(2);
  });

  it('runs jobs on their interval and stops gracefully', async () => {
    const scheduler = new Scheduler(mongo.db, log, { jitter: 0 });
    let calls = 0;
    let aborted = false;
    scheduler.register({
      name: 'ticker',
      intervalMs: 50,
      run: async (signal) => {
        calls++;
        signal.addEventListener('abort', () => (aborted = true));
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    scheduler.start();
    await expect.poll(() => calls, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
    await scheduler.stop();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(after);
    expect(aborted).toBe(true);
  });
});
