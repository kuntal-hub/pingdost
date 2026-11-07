import { describe, expect, it } from 'vitest';

import { createSerialQueue } from './serial-queue';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSerialQueue', () => {
  it('never runs two tasks at once and keeps their order', async () => {
    const enqueue = createSerialQueue();
    const log: string[] = [];
    const first = deferred();

    const a = enqueue(async () => {
      log.push('a start');
      await first.promise;
      log.push('a end');
    });
    const b = enqueue(() => {
      log.push('b start');
      return Promise.resolve();
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['a start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['a start', 'a end', 'b start']);
  });

  it('runs the next task after a failure, and the caller still sees that failure', async () => {
    const enqueue = createSerialQueue();
    const failed = enqueue(() => Promise.reject(new Error('no file')));
    const next = enqueue(() => Promise.resolve('ran'));

    await expect(failed).rejects.toThrow('no file');
    await expect(next).resolves.toBe('ran');
  });
});
