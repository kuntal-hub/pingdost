/**
 * A bounded in-memory cache with a time to live (Phase 27): hot read paths that would
 * otherwise spend Atlas Free/M0's 100 operations per second (docs/ops/capacity.md). Single
 * API process (ADR 0013), so invalidation is local.
 */
import type { Clock } from './clock';

export class TtlCache<V> {
  readonly #entries = new Map<string, { value: V; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock,
    private readonly maxEntries = 50_000,
  ) {}

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.clock.now() - entry.at >= this.ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.#entries.size >= this.maxEntries && !this.#entries.has(key)) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { value, at: this.clock.now() });
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}
