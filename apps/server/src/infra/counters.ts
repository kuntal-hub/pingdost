/**
 * In-memory fixed-window counters for per-account and per-email throttles (ARCHITECTURE A2:
 * rate limits stay in memory on a single instance). The key count is bounded: the oldest
 * windows are dropped first.
 */
import type { Clock } from './clock';

interface Window {
  count: number;
  resetAt: number;
}

export interface CounterState {
  /** False once `limit` hits have been counted in the current window. */
  allowed: boolean;
  count: number;
  /** Seconds until the window resets (at least 1). */
  retryAfterSeconds: number;
}

export class WindowCounter {
  readonly #windows = new Map<string, Window>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly clock: Clock,
    private readonly maxKeys = 50_000,
  ) {}

  /** Counts one hit for `key`; `allowed` says whether this hit is within the limit. */
  hit(key: string): CounterState {
    const window = this.#current(key) ?? this.#open(key);
    window.count++;
    return this.#state(window, window.count <= this.limit);
  }

  /** Without counting: `allowed` says whether one more hit would be within the limit. */
  peek(key: string): CounterState {
    const window = this.#current(key);
    if (!window) return { allowed: true, count: 0, retryAfterSeconds: 0 };
    return this.#state(window, window.count < this.limit);
  }

  reset(key: string): void {
    this.#windows.delete(key);
  }

  #current(key: string): Window | undefined {
    const window = this.#windows.get(key);
    if (window && window.resetAt > this.clock.now()) return window;
    this.#windows.delete(key);
    return undefined;
  }

  #open(key: string): Window {
    if (this.#windows.size >= this.maxKeys) {
      const oldest = this.#windows.keys().next();
      if (!oldest.done) this.#windows.delete(oldest.value);
    }
    const window = { count: 0, resetAt: this.clock.now() + this.windowMs };
    this.#windows.set(key, window);
    return window;
  }

  #state(window: Window, allowed: boolean): CounterState {
    return {
      allowed,
      count: window.count,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - this.clock.now()) / 1000)),
    };
  }
}
