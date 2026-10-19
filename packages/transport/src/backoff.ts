/** Exponential backoff with jitter, for reconnects and message retries. */
export interface BackoffOptions {
  /** The first delay; default 1 s. */
  baseMs?: number;
  /** The cap; default 60 s. */
  maxMs?: number;
  /** Random in [0, 1); default `Math.random`. */
  random?: () => number;
}

/**
 * The delay before attempt `attempt` (1-based): base × 2^(attempt − 1), capped, then scaled by
 * a random factor in [0.5, 1) so that many clients reconnecting together spread out.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 1_000;
  const max = options.maxMs ?? 60_000;
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const capped = Math.min(max, base * 2 ** exponent);
  return Math.round(capped * (0.5 + (options.random ?? Math.random)() * 0.5));
}
