import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildChain,
  CHAIN_LENGTH,
  firstSeat,
  isNextReveal,
  revealAt,
  rollDie,
  stateHash,
} from './fair-dice';

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());

describe('fair dice (ADR 0049)', () => {
  const chain = buildChain(sha256, new Uint8Array(32).fill(42));
  const anchor = chain[CHAIN_LENGTH]!;

  it('reveals the chain backwards, one secret at a time, never skipping', () => {
    expect(chain).toHaveLength(CHAIN_LENGTH + 1);
    expect(isNextReveal(sha256, anchor, revealAt(chain, 1))).toBe(true);
    expect(isNextReveal(sha256, revealAt(chain, 1), revealAt(chain, 2))).toBe(true);
    // Skipping a secret, repeating one, or a made-up one never counts.
    expect(isNextReveal(sha256, anchor, revealAt(chain, 2))).toBe(false);
    expect(isNextReveal(sha256, revealAt(chain, 1), revealAt(chain, 1))).toBe(false);
    expect(isNextReveal(sha256, anchor, new Uint8Array(32))).toBe(false);
    expect(() => revealAt(chain, CHAIN_LENGTH + 1)).toThrow();
    expect(() => revealAt(chain, 0)).toThrow();
  });

  it('rolls every face about equally, and the same inputs give the same die', () => {
    const counts = [0, 0, 0, 0, 0, 0];
    const gameId = new Uint8Array(16).fill(1);
    for (let i = 1; i <= 600; i++) {
      const die = rollDie(sha256, {
        reveal: revealAt(chain, i),
        salt: new Uint8Array(16).fill(i % 256),
        gameId,
        turn: i,
        index: 0,
      });
      counts[die - 1]!++;
    }
    for (const count of counts) expect(count).toBeGreaterThan(65);
    const input = { reveal: anchor, salt: new Uint8Array(16), gameId, turn: 3, index: 1 };
    expect(rollDie(sha256, input)).toBe(rollDie(sha256, input));
    // Another salt (the other player's latest event) changes the roll's input.
    const dice = new Set(
      Array.from({ length: 20 }, (_, i) =>
        rollDie(sha256, { ...input, salt: new Uint8Array(16).fill(i) }),
      ),
    );
    expect(dice.size).toBeGreaterThan(1);
  });

  it('picks a first seat in range and hashes states to 8 bytes', () => {
    const salts = [1, 2, 3].map((n) => new Uint8Array(16).fill(n));
    const seat = firstSeat(sha256, new Uint8Array(16), salts);
    expect(seat).toBeGreaterThanOrEqual(0);
    expect(seat).toBeLessThan(3);
    expect(stateHash(sha256, 'a')).toHaveLength(8);
    expect(stateHash(sha256, 'a')).not.toEqual(stateHash(sha256, 'b'));
  });
});
