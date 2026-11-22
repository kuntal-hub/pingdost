// A 52-card deck for the dealer games (ADR 0052: Call Bridge, Poker). Cards are 0–51: suit
// (0 spades, 1 hearts, 2 diamonds, 3 clubs) × 13 + rank (0 = 2 … 12 = ace).
import type { Sha256 } from './fair-dice';

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

/** Fisher–Yates over 52 cards with `next(n)` giving an unbiased integer in [0, n). */
export function shuffleDeck(next: (n: number) => number): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = next(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

/** An unbiased integer stream from SHA-256 of a seed (counter mode, rejection sampling). */
export function hashStream(sha256: Sha256, seed: Uint8Array): (n: number) => number {
  let counter = 0;
  let block: Uint8Array = new Uint8Array(0);
  let at = 0;
  const byte = () => {
    if (at >= block.length) {
      block = sha256(concatBytes(seed, u32(counter++)));
      at = 0;
    }
    return block[at++]!;
  };
  return (n) => {
    for (;;) {
      const v = (byte() << 8) | byte();
      const limit = 65536 - (65536 % n);
      if (v < limit) return v % n;
    }
  };
}

/** Solo games: a shuffled deck from a small xorshift state (the computer players never see it). */
export function soloDeck(rng: number): { rng: number; deck: number[] } {
  let r = rng >>> 0 || 1;
  const nextInt = (n: number) => {
    for (;;) {
      r ^= r << 13;
      r ^= r >>> 17;
      r ^= r << 5;
      r >>>= 0;
      const limit = 4294967296 - (4294967296 % n);
      if (r < limit) return r % n;
    }
  };
  const deck = shuffleDeck(nextInt);
  return { rng: r, deck };
}
