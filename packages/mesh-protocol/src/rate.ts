/**
 * Token buckets for the mesh's rate limits (REQ §11.4: packet creation, relay frequency,
 * per-origin quota and discovery). Keyed buckets are bounded, so many keys (many strangers)
 * cannot grow memory without limit: the least recently used key is forgotten first.
 */
import type { Rate } from './policy';

export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly rate: Rate,
    private readonly maxKeys = 1_024,
  ) {}

  /** Takes one event for `key` at `nowMs`; false when over the rate. */
  take(key: string, nowMs: number): boolean {
    const { perMinute, burst } = this.rate;
    const current = this.#buckets.get(key) ?? { tokens: burst, at: nowMs };
    const refill = ((nowMs - current.at) / 60_000) * perMinute;
    const tokens = Math.min(burst, current.tokens + Math.max(0, refill));
    this.#buckets.delete(key);
    if (tokens < 1) {
      this.#buckets.set(key, { tokens, at: nowMs });
      return false;
    }
    this.#buckets.set(key, { tokens: tokens - 1, at: nowMs });
    if (this.#buckets.size > this.maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
    return true;
  }
}
