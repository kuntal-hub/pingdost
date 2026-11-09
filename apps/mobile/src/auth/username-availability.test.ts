import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  availabilityNote,
  createAvailabilityChecker,
  type Availability,
  type AvailabilityCheck,
} from './username-availability';

describe('createAvailabilityChecker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(check: AvailabilityCheck) {
    const states: Availability[] = [];
    let clock = 0;
    const checker = createAvailabilityChecker({
      check,
      onChange: (state) => states.push(state),
      delayMs: 400,
      cacheMs: 60_000,
      now: () => clock,
    });
    return {
      checker,
      states,
      last: () => states.at(-1),
      tick: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('checks once after a pause, with the normalized name', async () => {
    const check = vi.fn<AvailabilityCheck>((username) =>
      Promise.resolve({ username, available: true }),
    );
    const { checker, last } = setup(check);
    checker.update('A');
    checker.update('Al');
    checker.update(' Alice ');
    expect(last()).toEqual({ state: 'idle' });
    await vi.advanceTimersByTimeAsync(399);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]?.[0]).toBe('alice');
    expect(last()).toEqual({ state: 'available', username: 'alice' });
  });

  it('shows local rule problems without asking the server', async () => {
    const check = vi.fn<AvailabilityCheck>();
    const { checker, last } = setup(check);
    checker.update('al');
    await vi.advanceTimersByTimeAsync(400);
    expect(last()).toEqual({ state: 'invalid', message: 'Too short: add 1 more character' });
    checker.update('al ice');
    await vi.advanceTimersByTimeAsync(400);
    expect(last()).toEqual({ state: 'invalid', message: 'No spaces: try _ or . instead' });
    checker.update('');
    expect(last()).toEqual({ state: 'idle' });
    expect(check).not.toHaveBeenCalled();
  });

  it('aborts an older request and never shows its answer', async () => {
    const signals: AbortSignal[] = [];
    const answers: ((taken: boolean) => void)[] = [];
    const check: AvailabilityCheck = (username, signal) => {
      signals.push(signal);
      return new Promise((resolve) => {
        answers.push((taken) =>
          resolve(
            taken ? { username, available: false, reason: 'taken' } : { username, available: true },
          ),
        );
      });
    };
    const { checker, states, last } = setup(check);
    checker.update('alice');
    await vi.advanceTimersByTimeAsync(400);
    expect(last()).toEqual({ state: 'checking', username: 'alice' });
    checker.update('alice2');
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    answers[0]?.(true);
    answers[1]?.(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ state: 'available', username: 'alice2' });
    expect(states.some((state) => state.state === 'taken')).toBe(false);
  });

  it('reuses a recent answer when the same name comes back', async () => {
    const check = vi.fn<AvailabilityCheck>((username) =>
      Promise.resolve({ username, available: false, reason: 'taken' as const }),
    );
    const { checker, last, tick } = setup(check);
    checker.update('bob');
    await vi.advanceTimersByTimeAsync(400);
    checker.update('bobby');
    checker.update('bob');
    expect(last()).toEqual({ state: 'taken', username: 'bob' });
    tick(61_000);
    checker.update('bob');
    expect(last()).toEqual({ state: 'idle' });
    await vi.advanceTimersByTimeAsync(400);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('says it could not check when the request fails', async () => {
    const { checker, last } = setup(() => Promise.reject(new Error('offline')));
    checker.update('carol');
    await vi.advanceTimersByTimeAsync(400);
    expect(last()).toEqual({ state: 'unknown' });
  });

  it('stops everything on dispose', async () => {
    const check = vi.fn<AvailabilityCheck>();
    const { checker } = setup(check);
    checker.update('dave');
    checker.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).not.toHaveBeenCalled();
  });
});

describe('availabilityNote', () => {
  it('words each state for the field', () => {
    expect(availabilityNote({ state: 'idle' })).toBeUndefined();
    expect(availabilityNote({ state: 'checking', username: 'x' })).toMatchObject({ busy: true });
    expect(availabilityNote({ state: 'available', username: 'alice' })).toEqual({
      tone: 'success',
      text: '@alice is available',
    });
    expect(availabilityNote({ state: 'taken', username: 'alice' })?.tone).toBe('danger');
    expect(availabilityNote({ state: 'unknown' })?.tone).toBe('muted');
  });
});
