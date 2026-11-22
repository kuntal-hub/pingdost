import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  bridgeSeatData,
  CALL_BRIDGE,
  chooseBridgeMove,
  dealerSecret,
  dealFrom,
  estimateCall,
  playableCards,
  roundPoints,
  trickWinner,
  type BridgeMove,
  type BridgeState,
} from './rules';
import { seededRandom } from '../core/random';
import type { BotLevel } from '../core/types';

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());
const rules = CALL_BRIDGE;
// Card helpers: suit index × 13 + rank (0 = 2 … 12 = ace).
const S = (rank: number) => rank;
const H = (rank: number) => 13 + rank;
const D = (rank: number) => 26 + rank;
const C = (rank: number) => 39 + rank;
const play = (seat: number, card: number) => ({ seat, card, p: -1 });

function playOut(levels: BotLevel[], seed: number): BridgeState {
  const random = seededRandom(seed);
  let state = rules.soloSetup!(rules.setup(4, {}, seed % 4), random);
  for (let i = 0; i < 2_000 && !state.ranks; i++) {
    state = rules.apply(state, chooseBridgeMove(state, levels[state.current]!, random));
  }
  return state;
}

describe('Call Bridge rules', () => {
  it('follows suit, else trumps, else anything', () => {
    const hand = [S(3), H(5), H(9), C(2)];
    expect(playableCards(hand, [play(0, H(12))])).toEqual([H(5), H(9)]);
    expect(playableCards(hand, [play(0, D(4))])).toEqual([S(3)]);
    expect(playableCards([H(5), C(2)], [play(0, D(4))])).toEqual([H(5), C(2)]);
    expect(playableCards(hand, [])).toEqual(hand);
  });

  it('the highest spade takes the trick, else the highest of the suit led', () => {
    expect(trickWinner([play(0, H(5)), play(1, H(12)), play(2, D(12)), play(3, H(2))])).toBe(1);
    expect(trickWinner([play(0, H(5)), play(1, H(12)), play(2, S(0)), play(3, S(1))])).toBe(3);
  });

  it('scores the call plus a tenth per extra trick, or minus the call', () => {
    expect(roundPoints(3, 3)).toBe(30);
    expect(roundPoints(3, 5)).toBe(32);
    expect(roundPoints(4, 2)).toBe(-40);
  });

  it('calls about what a hand is worth', () => {
    const strong = [
      S(12),
      S(11),
      S(10),
      S(9),
      S(8),
      H(12),
      D(12),
      C(12),
      H(1),
      D(1),
      C(1),
      H(2),
      D(2),
    ];
    expect(estimateCall(strong)).toBeGreaterThan(6);
    const weak = [H(0), H(1), H(2), D(0), D(1), D(2), C(0), C(1), C(2), C(3), H(3), D(3), S(0)];
    expect(estimateCall(weak)).toBeLessThan(1);
  });

  it('plays a whole solo game of five rounds', () => {
    const state = playOut(['medium', 'easy', 'medium', 'easy'], 3);
    expect(state.ranks).not.toBeNull();
    expect(state.history).toHaveLength(5);
    for (const round of state.history) expect(round.tricks.reduce((a, b) => a + b, 0)).toBe(13);
    expect(rules.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('Medium beats Easy, and Hard holds its own against Medium', () => {
    let medium = 0;
    let easy = 0;
    for (let g = 0; g < 30; g++) {
      const s = playOut(['medium', 'easy', 'medium', 'easy'], 100 + g);
      medium += s.scores[0]! + s.scores[2]!;
      easy += s.scores[1]! + s.scores[3]!;
    }
    expect(medium).toBeGreaterThan(easy);
    let hard = 0;
    let mid = 0;
    for (let g = 0; g < 6; g++) {
      const s = playOut(['hard', 'medium', 'hard', 'medium'], 200 + g);
      hard += s.scores[0]! + s.scores[2]!;
      mid += s.scores[1]! + s.scores[3]!;
    }
    expect(hard).toBeGreaterThan(mid - 20);
  }, 120_000);
});

describe('Call Bridge dealing (ADR 0052)', () => {
  const gameId = new Uint8Array(16).fill(5);
  const seed = new Uint8Array(32).fill(7);
  const salt = new Uint8Array(16).fill(3);

  it('deals 52 different cards the same way every time, from the secret and the salt', () => {
    const secret = dealerSecret(sha256, seed, 0);
    const a = dealFrom(sha256, secret, salt, gameId, 0);
    const b = dealFrom(sha256, secret, salt, gameId, 0);
    expect(new Set(a.deck).size).toBe(52);
    expect(a.deck).toEqual(b.deck);
    expect(dealFrom(sha256, secret, new Uint8Array(16).fill(4), gameId, 0).deck).not.toEqual(
      a.deck,
    );
    expect(bridgeSeatData(seed, sha256)).toHaveLength(80);
  });

  it('checks a revealed secret against the commitment made at join, and finds revokes', () => {
    const seatData = [1, 2, 3, 4].map((n) => bridgeSeatData(new Uint8Array(32).fill(n), sha256));
    const net = { sha256, gameId, seatData, salts: [], startSalt: new Uint8Array(16), host: 0 };
    let state = rules.hidden!.setupNet(4, {}, 0, net);
    const knowsDealer = { sha256, gameId, seed: new Uint8Array(32).fill(1), deals: [] };
    const step = { sha256, gameId, saltFor: () => salt };
    const { move, hands } = rules.hidden!.deal!(state, 0, knowsDealer, step);
    expect(hands.map((h) => h.seat)).toEqual([1, 2, 3]);
    state = rules.hidden!.applyNet(state, move, step);
    expect(state.phase).toBe('call');
    // Nobody's card is in the shared state.
    expect(state.hands.flat().every((c) => c.card === -1)).toBe(true);
    // Seat 2 reads its own hand from its private deal; the dealer works its own out.
    const seat2 = rules.hidden!.personalize(state, 2, {
      sha256,
      gameId,
      seed: null,
      deals: [{ round: 0, data: hands[1]!.data, from: 0 }],
    });
    expect(seat2.hands[2]!.every((c) => c.card >= 0)).toBe(true);
    expect(seat2.hands[1]!.every((c) => c.card === -1)).toBe(true);
    const dealerView = rules.hidden!.personalize(state, 0, knowsDealer);
    expect(dealerView.hands[0]!.every((c) => c.card >= 0)).toBe(true);
    // A forged card fails its commitment; the real one passes.
    for (let s = 1; s <= 4; s++) state = rules.hidden!.applyNet(state, { call: 1 }, step);
    expect(state.phase).toBe('play');
    const leader = state.current;
    const view = rules.hidden!.personalize(state, leader, {
      sha256,
      gameId,
      seed: null,
      deals: [{ round: 0, data: hands.find((h) => h.seat === leader)!.data, from: 0 }],
    });
    const real = rules.legal(view)[0] as { play: number; card: number };
    const proved = rules.hidden!.prove(state, real, leader, {
      sha256,
      gameId,
      seed: null,
      deals: [{ round: 0, data: hands.find((h) => h.seat === leader)!.data, from: 0 }],
    });
    expect(rules.hidden!.isLegalNet(state, proved, step)).toBe(true);
    expect(
      rules.hidden!.isLegalNet(
        state,
        { ...(proved as object), card: (real.card + 1) % 52 } as BridgeMove,
        step,
      ),
    ).toBe(false);
    // A wrong secret at the reveal is refused.
    const finished = { ...state, phase: 'reveal' as const, current: 0 };
    expect(rules.hidden!.isLegalNet(finished, { reveal: 'AAAA' }, step)).toBe(false);
    const secret = rules.hidden!.deal!(finished, 0, knowsDealer, step).move;
    expect(rules.hidden!.isLegalNet(finished, secret, step)).toBe(true);
  });
});
