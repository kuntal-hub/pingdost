import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  cardCode,
  cardFace,
  cardFromMix,
  chooseLastCardMove,
  DRAW_TWO,
  drawCommitment,
  drawSecret,
  LAST_CARD,
  lastCardSeatData,
  playableOn,
  REVERSE,
  SKIP,
  WILD,
  WILD_DRAW_FOUR,
  type LastCardMove,
  type LastCardState,
} from './rules';
import { seededRandom } from '../core/random';
import type { BotLevel } from '../core/types';

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());
const rules = LAST_CARD;

/** A solo-style state with chosen hands (cards known), seat 0 to play. */
function table(hands: number[][], top: number, color?: number): LastCardState {
  const base = rules.setup(hands.length, {}, 0);
  return {
    ...base,
    hands: hands.map((h) => h.map((card, k) => ({ k, card }))),
    draws: hands.map((h) => h.length),
    top,
    color: color ?? cardFace(top).color,
    rng: 12345,
  };
}
const R = (v: number) => cardCode(0, v);
const G = (v: number) => cardCode(2, v);
const B = (v: number) => cardCode(3, v);
const play = (
  state: LastCardState,
  k: number,
  extra: Partial<Extract<LastCardMove, { play: number }>> = {},
) =>
  rules.apply(state, {
    play: k,
    card: state.hands[state.current]!.find((c) => c.k === k)!.card,
    ...extra,
  });

describe('Last Card rules', () => {
  it('has the 108-card mix', () => {
    const counts = new Map<number, number>();
    for (let r = 0; r < 108; r++) counts.set(cardFromMix(r), (counts.get(cardFromMix(r)) ?? 0) + 1);
    expect(counts.get(R(0))).toBe(1);
    expect(counts.get(R(7))).toBe(2);
    expect(counts.get(B(DRAW_TWO))).toBe(2);
    expect(counts.get(cardCode(-1, WILD))).toBe(4);
    expect(counts.get(cardCode(-1, WILD_DRAW_FOUR))).toBe(4);
    expect(counts.size).toBe(54);
  });

  it('matches by color or by number, wilds anywhere', () => {
    const state = table([[R(5)], [B(1)]], G(5));
    expect(playableOn(state, R(5))).toBe(true);
    expect(playableOn(state, G(9))).toBe(true);
    expect(playableOn(state, B(1))).toBe(false);
    expect(playableOn(state, cardCode(-1, WILD))).toBe(true);
  });

  it('skips, reverses, draws two and four', () => {
    const three = table(
      [
        [R(SKIP), R(1), R(2)],
        [B(1), B(2)],
        [G(1), G(2)],
      ],
      R(3),
    );
    expect(play(three, 0).current).toBe(2);
    const rev = table(
      [
        [R(REVERSE), R(1), R(2)],
        [B(1), B(2)],
        [G(1), G(2)],
      ],
      R(3),
    );
    const afterReverse = play(rev, 0);
    expect(afterReverse.direction).toBe(-1);
    expect(afterReverse.current).toBe(2);
    // With two players a reverse is a skip.
    const two = play(
      table(
        [
          [R(REVERSE), R(1), R(2)],
          [B(1), B(2)],
        ],
        R(3),
      ),
      0,
    );
    expect(two.current).toBe(0);
    const drawTwo = play(table([[R(DRAW_TWO), R(1), R(2)], [B(1), B(2)], [G(1)]], R(3)), 0);
    expect(drawTwo.hands[1]).toHaveLength(4);
    expect(drawTwo.current).toBe(2);
    const four = play(
      table([[cardCode(-1, WILD_DRAW_FOUR), R(1), R(2)], [B(1)], [G(1)]], R(3)),
      0,
      { color: 2 },
    );
    expect(four.color).toBe(2);
    expect(four.hands[1]).toHaveLength(5);
    expect(four.current).toBe(2);
  });

  it('draws one, then plays it or passes; forgetting the call costs two', () => {
    const state = table([[B(9), B(8)], [G(1)]], R(3));
    expect(rules.isLegal(state, { play: 0, card: B(9) })).toBe(false);
    const drawn = rules.apply(state, { draw: true });
    expect(drawn.hands[0]).toHaveLength(3);
    expect(drawn.drawn).toBe(2);
    expect(drawn.current).toBe(0);
    const legalNow = rules.legal(drawn);
    expect(legalNow.some((m) => 'pass' in m)).toBe(true);
    expect(legalNow.every((m) => !('play' in m) || m.play === 2)).toBe(true);
    const passed = rules.apply(drawn, { pass: true });
    expect(passed.current).toBe(1);
    const forgot = play(table([[R(1), R(2)], [G(1)]], R(3)), 0);
    expect(forgot.hands[0]).toHaveLength(3);
    const called = play(table([[R(1), R(2)], [G(1)]], R(3)), 0, { call: true });
    expect(called.hands[0]).toHaveLength(1);
  });

  it('ends when a hand is empty; the others by cards left, with points in solo', () => {
    const done = play(table([[R(1)], [G(1), G(2), cardCode(-1, WILD)], [B(SKIP)]], R(3)), 0);
    expect(done.ranks).toEqual([1, 3, 2]);
    expect(rules.resultDetail!(done)).toBe('73 points from the cards left');
  });

  it('a solo game starts with seven cards each and a number card, and saves', () => {
    const solo = rules.soloSetup!(rules.setup(3, {}, 0), seededRandom(4));
    expect(solo.hands.map((h) => h.length)).toEqual([7, 7, 7]);
    expect(cardFace(solo.top).value).toBeLessThanOrEqual(9);
    expect(rules.restore(JSON.parse(JSON.stringify(solo)))).toEqual(solo);
  });

  it('computer players finish games, and Medium and Hard beat Easy', () => {
    const tally = (a: BotLevel, b: BotLevel, games: number, seed: number) => {
      const random = seededRandom(seed);
      let won = 0;
      for (let g = 0; g < games; g++) {
        let state = rules.soloSetup!(rules.setup(2, {}, g % 2), random);
        const levels = [a, b];
        for (let i = 0; i < 2_000 && !state.ranks; i++) {
          state = rules.apply(state, chooseLastCardMove(state, levels[state.current]!, random));
        }
        expect(state.ranks).not.toBeNull();
        if (state.ranks![0] === 1) won++;
      }
      return won / games;
    };
    expect(tally('medium', 'easy', 600, 5)).toBeGreaterThan(0.55);
    expect(tally('hard', 'easy', 600, 6)).toBeGreaterThan(0.55);
  }, 60_000);
});

describe('Last Card hidden hands (ADR 0052)', () => {
  const gameId = new Uint8Array(16).fill(9);
  const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const salts = [11, 12, 13].map((n) => new Uint8Array(16).fill(n));
  const net = {
    sha256,
    gameId,
    seatData: seeds.map((s) => lastCardSeatData(s, sha256)),
    salts,
    startSalt: new Uint8Array(16).fill(99),
    host: 0,
  };
  const knows = (seat: number) => ({ sha256, gameId, seed: seeds[seat]!, deals: [] });
  const step = (salt: number) => ({ sha256, gameId, saltFor: () => new Uint8Array(16).fill(salt) });

  it('deals hidden hands only their owner can read', () => {
    const state = rules.hidden!.setupNet(3, {}, 0, net);
    expect(state.hands.map((h) => h.length)).toEqual([7, 7, 7]);
    expect(state.hands.flat().every((c) => c.card === 0)).toBe(true);
    const mine = rules.hidden!.personalize(state, 1, knows(1));
    expect(mine.hands[1]!.every((c) => c.card > 0)).toBe(true);
    expect(mine.hands[0]!.every((c) => c.card === 0)).toBe(true);
    // Another seat's secret reads different cards (it can't read seat 1's hand).
    const wrong = rules.hidden!.personalize(state, 1, knows(2));
    expect(wrong.hands[1]!.map((c) => c.card)).not.toEqual(mine.hands[1]!.map((c) => c.card));
    expect(drawCommitment(sha256, drawSecret(sha256, seeds[1]!, 0))).toEqual(
      net.seatData[1]!.slice(0, 16),
    );
  });

  it('accepts a played card only with the right secret, and keeps draws hidden', () => {
    let state = rules.hidden!.setupNet(3, {}, 0, net);
    const view = rules.hidden!.personalize(state, 0, knows(0));
    const options = rules.legal(view);
    const chosen = options.find((m) => 'play' in m) ?? { draw: true as const };
    if ('play' in chosen) {
      const proved = rules.hidden!.prove(state, chosen, 0, knows(0)) as typeof chosen;
      expect(rules.hidden!.isLegalNet(state, proved, step(1))).toBe(true);
      // Someone else's secret, or a different card, is refused.
      const forged = rules.hidden!.prove(state, chosen, 0, knows(1));
      expect(rules.hidden!.isLegalNet(state, forged, step(1))).toBe(false);
      expect(
        rules.hidden!.isLegalNet(state, { ...proved, card: proved.card === 1 ? 2 : 1 }, step(1)),
      ).toBe(false);
      state = rules.hidden!.applyNet(state, proved, step(1));
      expect(state.top).toBe(chosen.card);
    } else {
      state = rules.hidden!.applyNet(state, chosen, step(1));
      expect(state.hands[0]).toHaveLength(8);
      expect(state.hands[0]!.every((c) => c.card === 0)).toBe(true);
    }
    // The public state never holds a card that wasn't played.
    expect(state.hands.flat().every((c) => c.card === 0)).toBe(true);
  });
});
