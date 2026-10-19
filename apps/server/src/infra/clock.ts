/** Time source, injectable so tests can move past TTLs. Epoch milliseconds. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
