// Randomness for games played on this device (ADR 0049). Friend games take their dice from
// commit-reveal instead (Phase 42); solo games use the platform's CSPRNG.

export interface Random {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
  /** An unbiased die roll, 1..6. */
  die(): number;
}

/** Dice from `crypto.getRandomValues`, unbiased by rejection sampling. */
export function cryptoRandom(): Random {
  const buffer = new Uint32Array(1);
  const word = (): number => {
    globalThis.crypto.getRandomValues(buffer);
    return buffer[0]!;
  };
  return fromWords(word);
}

/**
 * A small deterministic generator (sfc32) for tests and for the computer players'
 * tie-breaks. Never for anything that must be unpredictable.
 */
export function seededRandom(seed: number): Random {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  const word = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 12; i++) word();
  return fromWords(word);
}

const TWO_32 = 0x1_0000_0000;

function fromWords(word: () => number): Random {
  const int = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0 || n > TWO_32) throw new RangeError('bad range');
    // Reject the top sliver of the 32-bit range so every value is equally likely.
    const limit = TWO_32 - (TWO_32 % n);
    for (;;) {
      const value = word();
      if (value < limit) return value % n;
    }
  };
  return {
    next: () => word() / TWO_32,
    int,
    die: () => int(6) + 1,
  };
}
