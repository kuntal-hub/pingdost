import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { create, GameMoveSchema, toBase64 } from '@pingdost/protocol';

import { estimateEquity } from './bot';
import { handCategory, handName, handPhrase, handScore, startingStrength } from './hands';
import {
  buildPots,
  POKER,
  pokerDeal,
  pokerResultLine,
  pokerSecret,
  pokerSeatData,
  potTotal,
  raiseRange,
  type PokerMove,
} from './rules';
import { seededRandom } from '../core/random';
import type { BotLevel } from '../core/types';

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());
const rules = POKER;
// Cards: suit × 13 + rank (0 = 2 … 12 = ace); spades, hearts, diamonds, clubs.
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const card = (code: string) => SUITS.indexOf(code[1]!) * 13 + RANKS.indexOf(code[0]!);
const cards = (codes: string) => codes.split(' ').map(card);
const score = (codes: string) => handScore(cards(codes));

/** A solo game played to the end; checks the chips add up after every step. */
function playSolo(levels: BotLevel[], seed: number, settings = rules.defaultSettings, hands = 400) {
  const random = seededRandom(seed);
  let state = rules.soloSetup!(rules.setup(levels.length, settings, seed % levels.length), random);
  const total = settings.chips * levels.length;
  for (let i = 0; i < 40_000 && !state.ranks && state.hand < hands; i++) {
    const auto = rules.auto!(state);
    const move = auto ?? (rules.bot(state, levels[state.current]!, random) as PokerMove);
    const next = rules.apply(state, move);
    expect(next, `step ${i} ${JSON.stringify(move)} in ${state.phase}`).not.toBe(state);
    state = next;
    const chips = state.stacks.reduce((a, b) => a + b, 0) + potTotal(state);
    expect(chips).toBe(total);
  }
  return state;
}

describe('poker hands', () => {
  it('ranks the categories in order', () => {
    const ladder = [
      'As Kd 9h 7c 4s 3d 2h',
      'As Ad 9h 7c 4s 3d 2h',
      'As Ad 9h 9c 4s 3d 2h',
      'As Ad Ah 9c 4s 3d 2h',
      'Ts 9d 8h 7c 6s 3d 2h',
      'As Ks 9s 7s 4s 3d 2h',
      'As Ad Ah 9c 9s 3d 2h',
      'As Ad Ah Ac 4s 3d 2h',
      '9s 8s 7s 6s 5s 3d 2h',
    ].map(score);
    ladder.forEach((s, i) => expect(handCategory(s)).toBe(i));
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!);
  });

  it('knows the wheel, kickers, two trips and split pots', () => {
    expect(handName(score('As 2d 3h 4c 5s Kd Qh'))).toBe('Straight, five high');
    expect(score('6s 2d 3h 4c 5s Kd Qh')).toBeGreaterThan(score('As 2d 3h 4c 5s Kd Qh'));
    // Same pair, the kicker decides.
    expect(score('Ks Kd Ah 9c 4s 3d 2h')).toBeGreaterThan(score('Ks Kd Qh 9c 4s 3d 2h'));
    // Two trips make a full house with the higher trips on top.
    expect(handName(score('9s 9d 9h 4c 4s 4d 2h'))).toBe('Full house, nines over fours');
    // The board plays for both: a tie.
    expect(score('2s 3d Ah Kc Qs Jd Th')).toBe(score('4s 5d Ah Kc Qs Jd Th'));
    expect(handName(score('As Ks Qs Js Ts 3d 2h'))).toBe('Royal flush');
    expect(handPhrase(score('As Ks 9s 7s 4s 3d 2h'))).toBe('a flush, ace high');
    expect(handPhrase(score('As Kd 9h 7c 4s 3d 2h'))).toBe('ace high');
    expect(handPhrase(score('As Ad 9h 9c 4s 3d 2h'))).toBe('two pair, aces and nines');
    // A flush on six cards keeps the best five.
    expect(score('As Ks 9s 7s 4s 2s 2h')).toBeGreaterThan(score('As Ks 9s 7s 3s 2s 2h'));
  });

  it('rates starting hands and estimates equity sensibly', () => {
    expect(startingStrength(card('As'), card('Ad'))).toBe(1);
    expect(startingStrength(card('7s'), card('2d'))).toBeLessThan(0.15);
    expect(startingStrength(card('Ks'), card('Qs'))).toBeGreaterThan(
      startingStrength(card('Ks'), card('Qd')),
    );
    const random = seededRandom(1);
    const aces = estimateEquity(cards('As Ad'), [], 1, 2000, random);
    expect(aces).toBeGreaterThan(0.8);
    expect(aces).toBeLessThan(0.9);
    const junk = estimateEquity(cards('7s 2d'), [], 1, 2000, random);
    expect(junk).toBeLessThan(0.4);
    // Made nuts on the river.
    expect(estimateEquity(cards('As Ks'), cards('Qs Js Ts 3d 2h'), 3, 200, random)).toBe(1);
  });
});

describe('poker pots and betting', () => {
  it('builds side pots from all-ins, and gives back an uncalled bet', () => {
    // Seat 0 all in for 100, seat 1 for 300, seat 2 covers; seat 3 folded after 50.
    const pots = buildPots([100, 300, 500, 50], [0, 1, 2]);
    expect(pots.map((p) => [p.amount, p.seats])).toEqual([
      [350, [0, 1, 2]],
      [400, [1, 2]],
      [200, [2]],
    ]);
    expect(pots.reduce((a, p) => a + p.amount, 0)).toBe(950);
  });

  it('heads-up: the button posts the small blind and acts first; the big blind has the option', () => {
    let state = rules.soloSetup!(rules.setup(2, rules.defaultSettings, 0), seededRandom(4));
    state = rules.apply(state, { next: true });
    expect(state.phase).toBe('bet');
    expect(state.bets).toEqual([10, 20]);
    expect(state.current).toBe(0);
    state = rules.apply(state, { act: 'call' });
    // The big blind may still raise.
    expect(state.current).toBe(1);
    expect(rules.legal(state).some((m) => 'act' in m && m.act === 'raise')).toBe(true);
    state = rules.apply(state, { act: 'check' });
    expect(state.phase).toBe('board');
    state = rules.apply(state, { next: true });
    expect(state.board).toHaveLength(3);
    // After the flop the big blind acts first.
    expect(state.current).toBe(1);
  });

  it('raises by at least the last raise; a short all-in does not reopen raising', () => {
    let state = rules.soloSetup!(rules.setup(3, rules.defaultSettings, 0), seededRandom(9));
    state = { ...rules.apply(state, { next: true }) };
    // Button 0, small blind 1, big blind 2: the button acts first.
    expect(state.current).toBe(0);
    expect(raiseRange(state)).toEqual({ min: 40, max: 1000 });
    state = rules.apply(state, { act: 'raise', to: 100 });
    // The next raise must be by 80 at least.
    expect(raiseRange(state)!.min).toBe(180);
    expect(rules.isLegal(state, { act: 'raise', to: 150 })).toBe(false);
    // The small blind has only 140 left in all: its all-in is a short raise.
    state = { ...state, stacks: state.stacks.map((v, s) => (s === 1 ? 130 : v)) };
    expect(raiseRange(state)).toEqual({ min: 140, max: 140 });
    state = rules.apply(state, { act: 'raise', to: 140 });
    expect(state.actions[1]!.act).toBe('all-in');
    state = rules.apply(state, { act: 'call' });
    // Back to the first raiser: it may call the extra 40 but not raise again.
    expect(state.current).toBe(0);
    expect(raiseRange(state)).toBeNull();
    expect(rules.legal(state).map((m) => ('act' in m ? m.act : '?'))).toEqual(['fold', 'call']);
  });
});

describe('poker solo games', () => {
  for (const level of ['easy', 'medium', 'hard'] as const) {
    it(`plays a whole game against ${level} computers`, () => {
      const state = playSolo(['medium', level, level], 30 + level.length);
      expect(state.ranks).not.toBeNull();
      expect(state.phase).toBe('done');
      expect(new Set(state.ranks).size).toBeGreaterThan(1);
      expect(rules.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
    }, 60_000);
  }

  it('saves and restores a game in the middle of a hand', () => {
    const random = seededRandom(5);
    let state = rules.soloSetup!(rules.setup(4, rules.defaultSettings, 1), random);
    for (let i = 0; i < 25; i++) {
      state = rules.apply(
        state,
        rules.auto!(state) ?? (rules.bot(state, 'medium', random) as PokerMove),
      );
    }
    expect(rules.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('ends a solo game when the user (seat 0) runs out of chips', () => {
    const state = playSolo(['easy', 'hard', 'hard', 'hard'], 77);
    expect(state.ranks).not.toBeNull();
    const userOut = state.busted.flat().includes(0);
    if (userOut) expect(state.ranks![0]).toBeGreaterThan(1);
  }, 60_000);

  it('Medium beats Easy, and Hard beats Medium (duplicate matches of 40 hands)', () => {
    const settings = { chips: 2000, risingBlinds: false };
    // Each seed is played twice with the seats swapped: the same cards (the solo deck has its
    // own random state) go to each player once, so luck cancels out.
    const contest = (a: BotLevel, b: BotLevel, games: number) => {
      let total = 0;
      for (let g = 0; g < games; g++) {
        const first = playSolo([a, b], 500 + g, settings, 40);
        const second = playSolo([b, a], 500 + g, settings, 40);
        total += first.stacks[0]! - first.stacks[1]! + second.stacks[1]! - second.stacks[0]!;
      }
      return total;
    };
    expect(contest('medium', 'easy', 8)).toBeGreaterThan(0);
    expect(contest('hard', 'medium', 8)).toBeGreaterThan(0);
  }, 120_000);
});

describe('poker dealing (ADR 0052, 0053)', () => {
  const gameId = new Uint8Array(16).fill(5);
  const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const salt = new Uint8Array(16).fill(9);
  const step = { sha256, gameId, saltFor: () => salt };
  const knows = (
    seat: number,
    deals: { round: number; data: Uint8Array; from: number }[] = [],
  ) => ({
    sha256,
    gameId,
    seed: seeds[seat]!,
    deals,
  });

  it('pins the deal: the same secret and salt always give the same cards (vector)', () => {
    const secret = pokerSecret(sha256, seeds[0]!, 0);
    const a = pokerDeal(sha256, secret, salt, gameId, 0, 3);
    expect(a.deck).toEqual(pokerDeal(sha256, secret, salt, gameId, 0, 3).deck);
    expect(new Set(a.deck).size).toBe(52);
    expect(a.commitments).toHaveLength((2 * 3 + 5) * 16);
    expect(pokerDeal(sha256, secret, new Uint8Array(16), gameId, 0, 3).deck).not.toEqual(a.deck);
    // The dealing chain's end is the seat data; hand h uses the link 1,023 − h.
    expect(pokerSeatData(seeds[0]!, sha256)).toHaveLength(32);
    expect(a.deck.slice(0, 11)).toEqual(POKER_DEAL_VECTOR);
  });

  it('deals hidden hands, proves every card turned up, and checks the deal at the end', () => {
    const net = {
      sha256,
      gameId,
      seatData: seeds.map((s) => pokerSeatData(s, sha256)),
      salts: [],
      startSalt: new Uint8Array(16),
      host: 0,
    };
    const hidden = rules.hidden!;
    let state = hidden.setupNet(3, rules.defaultSettings, 0, net);
    expect(hidden.dealer!(state)).toBe(0);
    const { move, hands } = hidden.deal!(state, 0, knows(0), step);
    expect(hands.map((h) => h.seat)).toEqual([1, 2]);
    state = hidden.applyNet(state, move, step);
    expect(state.phase).toBe('bet');
    expect(state.holes.flat().every((c) => c === -1)).toBe(true);
    // Each player sees only their own two cards; the dealer works its own out.
    const seat1 = hidden.personalize(
      state,
      1,
      knows(1, [{ round: 0, data: hands[0]!.data, from: 0 }]),
    );
    expect(seat1.holes[1]!.every((c) => c >= 0)).toBe(true);
    expect(seat1.holes[2]!.every((c) => c === -1)).toBe(true);
    expect(hidden.personalize(state, 0, knows(0)).holes[0]!.every((c) => c >= 0)).toBe(true);
    // A private deal that doesn't match the commitments shows nothing.
    const forged = hands[0]!.data.slice();
    forged[0] = (forged[0]! + 1) % 52;
    expect(
      hidden.personalize(state, 1, knows(1, [{ round: 0, data: forged, from: 0 }])).holes[1],
    ).toEqual([-1, -1]);

    // Everyone calls or checks to the flop: the dealer turns it up with proofs.
    for (let i = 0; i < 3 && state.phase === 'bet'; i++) {
      const owe = state.bet - state.bets[state.current]!;
      state = hidden.applyNet(state, owe > 0 ? { act: 'call' } : { act: 'check' }, step);
    }
    expect(state.phase).toBe('board');
    const flop = hidden.deal!(state, 0, knows(0), step).move as { cards: { card: number }[] };
    expect(flop.cards).toHaveLength(3);
    const tampered = {
      cards: flop.cards.map((c, i) => (i === 0 ? { ...c, card: (c.card + 1) % 52 } : c)),
    } as PokerMove;
    expect(hidden.isLegalNet(state, tampered, step)).toBe(false);
    expect(hidden.isLegalNet(state, flop as PokerMove, step)).toBe(true);
    state = hidden.applyNet(state, flop as PokerMove, step);
    expect(state.board).toHaveLength(3);

    // Check it down: turn, river, then each player's app shows their cards.
    const knowsOf = (s: number) =>
      knows(s, s === 0 ? [] : [{ round: 0, data: hands[s - 1]!.data, from: 0 }]);
    for (let guard = 0; guard < 40 && state.phase !== 'reveal'; guard++) {
      if (state.phase === 'bet') state = hidden.applyNet(state, { act: 'check' }, step);
      else {
        const seat = hidden.dealer!(state)!;
        state = hidden.applyNet(state, hidden.deal!(state, seat, knowsOf(seat), step).move, step);
      }
    }
    expect(state.phase).toBe('reveal');
    expect(state.shown).toEqual([true, true, true]);
    expect(state.last!.won.reduce((a, b) => a + b, 0)).toBe(60);
    // The dealer's secret must be the right link of its chain.
    expect(hidden.isLegalNet(state, { reveal: toBase64(new Uint8Array(32)) }, step)).toBe(false);
    const reveal = hidden.deal!(state, 0, knows(0), step).move;
    expect(hidden.isLegalNet(state, reveal, step)).toBe(true);
    state = hidden.applyNet(state, reveal, step);
    expect(state.badDeal).toBe(false);
    expect(state.phase).toBe('deal');
    expect(state.button).toBe(1);
    expect(state.tipAt[0]).toBe(1023);
  });

  it('an absent player checks or folds; an absent dealer passes; an absent shower mucks', () => {
    const net = {
      sha256,
      gameId,
      seatData: seeds.map((s) => pokerSeatData(s, sha256)),
      salts: [],
      startSalt: new Uint8Array(16),
      host: 0,
    };
    let state = rules.hidden!.setupNet(3, rules.defaultSettings, 0, net);
    const random = seededRandom(1);
    expect(rules.proxy!(state, random)).toEqual({ pass: true });
    // The dealer never deals: the next seat gets the button for the next hand.
    state = rules.hidden!.applyNet(state, { pass: true }, step);
    expect(state.button).toBe(1);
    expect(state.hand).toBe(1);
    const dealt = rules.hidden!.deal!(state, 1, knows(1), step).move;
    state = rules.hidden!.applyNet(state, dealt, step);
    expect(rules.proxy!(state, random)).toEqual({ act: 'fold' });
    const before = state.stacks.reduce((a, b) => a + b, 0) + potTotal(state);
    // The dealer disappears after the deal: the hand is called off and bets go back.
    state = rules.hidden!.applyNet(state, { act: 'call' }, step);
    state = rules.hidden!.applyNet(state, { act: 'call' }, step);
    state = rules.hidden!.applyNet(state, { act: 'check' }, step);
    expect(state.phase).toBe('board');
    state = rules.hidden!.applyNet(state, { pass: true }, step);
    expect(state.last!.void).toBe(true);
    expect(state.stacks).toEqual([1000, 1000, 1000]);
    expect(state.stacks.reduce((a, b) => a + b, 0)).toBe(before);
  });

  it('sends every kind of step over the wire and reads it back', () => {
    const moves: PokerMove[] = [
      { act: 'fold' },
      { act: 'check' },
      { act: 'call' },
      { act: 'raise', to: 340 },
      { deal: toBase64(new Uint8Array(11 * 16).fill(1)) },
      {
        cards: [
          { p: 6, card: 0, nonce: toBase64(new Uint8Array(16).fill(2)) },
          { p: 7, card: 51, nonce: toBase64(new Uint8Array(16).fill(3)) },
        ],
      },
      { reveal: toBase64(new Uint8Array(32).fill(4)) },
      { muck: true },
      { pass: true },
    ];
    for (const move of moves) {
      const wire = create(GameMoveSchema, { play: rules.moveToWire(move) });
      expect(rules.moveFromWire(wire)).toEqual(move);
    }
    const settings = { chips: 5000, risingBlinds: false };
    const wire = rules.settingsToWire(settings);
    expect(wire).toEqual({ case: 'poker', value: { startingChips: 5000, fixedBlinds: true } });
  });

  it('says how a hand ended', () => {
    const name = (s: number) => ['You', 'Bob', 'Carol'][s]!;
    const result = {
      hand: 3,
      board: cards('As Kd 9h 7c 4s'),
      shown: [cards('Ah Ad'), cards('2s 3s'), null],
      scores: [score('Ah Ad As Kd 9h 7c 4s'), score('2s 3s As Kd 9h 7c 4s'), null],
      won: [1240, 0, 0],
      pots: [{ amount: 1240, seats: [0, 1], winners: [0] }],
      void: false,
    };
    expect(pokerResultLine(result, name)).toBe('You win 1,240 with three aces');
    // Everyone else folded: no hand is named.
    const folded = { ...result, won: [0, 120, 0], scores: [null, null, null] };
    expect(pokerResultLine(folded, name)).toBe('Bob wins 120');
    expect(pokerResultLine({ ...result, void: true }, name)).toBe(
      'Hand called off: every bet went back',
    );
  });
});

/** The first cards of the pinned deal above (seat 0, hand 0, salt of 9s, game ID of 5s). */
const POKER_DEAL_VECTOR = [1, 36, 2, 3, 24, 30, 43, 11, 49, 46, 48];
