// Poker (Phase 47, ADR 0053): no-limit Texas Hold'em for 2 to 6 players with play chips only
// (nothing is bought, paid or won). Blinds start at 10 and 20 and double every 10 hands unless
// fixed; the last player with chips wins.
//
// A hand: the button deals two cards each (blinds posted), a round of betting, then the flop
// (three shared cards), turn and river, each followed by betting. Hands left at the end show
// down; side pots keep all-ins fair. Solo games run the dealing as steps of their own
// (`auto`), with the whole deck in the state; the computer players look only at their cards.
//
// With friends the button's app deals (ADR 0052, rotating dealer): the deck comes from the
// dealer's secret for the hand (the next link down a hash chain whose end it published when it
// sat down) and a salt it didn't choose. It publishes a commitment per position, sends each
// seat its two cards privately, turns up the board with each card's nonce, and at the hand's
// end shows its secret so everyone checks the whole deal. At the showdown each player's app
// shows their cards with their nonces. An absent player checks or folds (30 s timers); an
// absent dealer passes.
import { GameType, fromBase64, toBase64 } from '@pingdost/protocol';

import { choosePokerMove } from './bot';
import { handPhrase, handScore } from './hands';
import { concatBytes, hashStream, shuffleDeck, soloDeck, u32 } from '../core/deck';
import { buildChain, chainStep, CHAIN_LENGTH, sameBytes, type Sha256 } from '../core/fair-dice';
import type { Random } from '../core/random';
import {
  placesFrom,
  restoreCore,
  turnCore,
  type Knowledge,
  type NetSetup,
  type NetStep,
  type TurnCore,
  type TurnRules,
} from '../core/turn';
import type { BotLevel } from '../core/types';

export const POKER_CHIPS = [500, 1000, 2000, 5000] as const;
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const BLINDS_EVERY = 10;
/** Hands per game at most (each dealer secret is one link of a 1,024-link chain). */
export const POKER_MAX_HANDS = 1000;
/** Solo games: the user's seat (`turn-solo.ts` always seats the user at 0). */
const SOLO_USER = 0;
const COMMIT_BYTES = 16;

export interface PokerSettings {
  /** Chips each player starts with. */
  chips: number;
  /** The blinds double every `BLINDS_EVERY` hands. */
  risingBlinds: boolean;
}

export type PokerPhase = 'deal' | 'bet' | 'board' | 'show' | 'reveal' | 'done';
export type PokerAct =
  'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in' | 'small blind' | 'big blind';

export interface PokerAction {
  act: PokerAct;
  /** The seat's bet in this round after the action. */
  amount: number;
}

export interface PokerPot {
  amount: number;
  /** Who could win it. */
  seats: number[];
  winners: number[];
}

/** How a hand ended, kept until the next one ends (the table shows it between hands). */
export interface PokerResult {
  hand: number;
  board: number[];
  /** Hole cards turned up at the showdown (null: not shown). */
  shown: (number[] | null)[];
  /** The best five of each shown hand (null: not shown). */
  scores: (number | null)[];
  won: number[];
  pots: PokerPot[];
  /** The hand was called off (its dealer was gone): every bet went back. */
  void: boolean;
}

export interface PokerState extends TurnCore {
  /** Solo: the deck is in the state and dealing runs as `auto` steps. */
  solo: boolean;
  /** 0-based. */
  hand: number;
  button: number;
  phase: PokerPhase;
  sb: number;
  bb: number;
  /** Chips in front of each player (not yet bet). */
  stacks: number[];
  /** This round of betting. */
  bets: number[];
  /** This hand, all rounds (side pots come from these). */
  contrib: number[];
  dealt: boolean[];
  folded: boolean[];
  /** Must still act in this round. */
  toAct: boolean[];
  /** The raise level when the seat last acted this round (−1: not yet). */
  actedAt: number[];
  /** The bet to match in this round. */
  bet: number;
  /** The bet after the last full raise: a short all-in doesn't reopen raising. */
  raiseLevel: number;
  /** The smallest raise (the last full raise, at least the big blind). */
  minRaise: number;
  /** Two cards per seat dealt in (−1: face down to this view), [] for others. */
  holes: number[][];
  shown: boolean[];
  board: number[];
  actions: (PokerAction | null)[];
  /** Seats that ran out of chips, by hand (first out first). */
  busted: number[][];
  last: PokerResult | null;
  /** With friends: the hand's commitments and deal salt (base64). */
  commits: string;
  dealSalt: string;
  /** Each seat's dealing chain: the last link shown (the anchor first) and its index. */
  tips: string[];
  tipAt: number[];
  /** A dealer's shown secret did not match its deal. */
  badDeal: boolean;
  /** Hands whose dealer never showed its secret. */
  unchecked: number;
  /** Solo: this hand's deck, and the random state the next comes from. */
  deck: number[];
  rng: number;
  settings: PokerSettings;
}

export interface PokerProof {
  p: number;
  card: number;
  nonce: string;
}

export type PokerMove =
  | { act: 'fold' | 'check' | 'call' }
  | { act: 'raise'; to: number }
  | { deal: string }
  | { cards: PokerProof[] }
  | { reveal: string }
  | { muck: true }
  | { pass: true }
  | { next: true };

export type PokerBet = Extract<PokerMove, { act: unknown }>;

// Table helpers

const seatsOf = (state: { seats: number }) => Array.from({ length: state.seats }, (_, s) => s);
const fill = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value);

/** The first seat after `from` (going round, `from` itself last) that passes `ok`, or −1. */
function nextSeat(n: number, from: number, ok: (seat: number) => boolean): number {
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (ok(seat)) return seat;
  }
  return -1;
}

/** Seats still in this hand (dealt, not folded). */
export function liveSeats(state: PokerState): number[] {
  return seatsOf(state).filter((s) => state.dealt[s] && !state.folded[s]);
}

/** Seats still in the game (not out of chips, not left). */
export function aliveSeats(state: PokerState): number[] {
  const out = new Set(state.busted.flat());
  return seatsOf(state).filter((s) => !state.left[s] && !out.has(s));
}

export function potTotal(state: PokerState): number {
  return state.contrib.reduce((a, b) => a + b, 0);
}

export function blindsFor(settings: PokerSettings, hand: number): [number, number] {
  const level = settings.risingBlinds ? Math.min(20, Math.floor(hand / BLINDS_EVERY)) : 0;
  return [SMALL_BLIND * 2 ** level, BIG_BLIND * 2 ** level];
}

/** Board positions in the deal: two per seat first, then the five shared cards. */
const boardBase = (state: { seats: number }) => 2 * state.seats;

function nextBoardPositions(state: PokerState): number[] {
  const base = boardBase(state);
  const have = state.board.length;
  if (have === 0) return [base, base + 1, base + 2];
  return have < 5 ? [base + have] : [];
}

export const STREETS = ['flop', 'turn', 'river'] as const;

/** 1,240 → "1,240". */
export function formatChips(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Betting

/** The raise this seat may make now ("raise to" amounts), or null if it can only call. */
export function raiseRange(state: PokerState): { min: number; max: number } | null {
  if (state.phase !== 'bet') return null;
  const seat = state.current;
  const max = state.bets[seat]! + state.stacks[seat]!;
  if (max <= state.bet) return null;
  // A short all-in doesn't reopen raising for someone who already acted at this level.
  if (state.actedAt[seat]! >= state.raiseLevel) return null;
  // Nobody left who could answer a raise.
  if (!liveSeats(state).some((s) => s !== seat && state.stacks[s]! > 0)) return null;
  return { min: Math.min(max, state.bet + state.minRaise), max };
}

/** What calling costs the seat to act now (capped by its chips). */
export function toCall(state: PokerState): number {
  const seat = state.current;
  return Math.min(state.bet - state.bets[seat]!, state.stacks[seat]!);
}

/** "Raise to" for a share of the pot (a pot-sized raise: call, then raise by the pot). */
export function potRaise(state: PokerState, share: number): number {
  const owe = state.bet - state.bets[state.current]!;
  return Math.round(state.bet + share * (potTotal(state) + owe));
}

function isLegalBet(state: PokerState, move: PokerBet): boolean {
  if (state.ranks || state.phase !== 'bet') return false;
  const owe = state.bet - state.bets[state.current]!;
  switch (move.act) {
    case 'fold':
    case 'call':
      return owe > 0;
    case 'check':
      return owe === 0;
    case 'raise': {
      const range = raiseRange(state);
      return (
        range !== null && Number.isInteger(move.to) && move.to >= range.min && move.to <= range.max
      );
    }
    default:
      return false;
  }
}

function act(state: PokerState, move: PokerBet): PokerState {
  const seat = state.current;
  const stacks = [...state.stacks];
  const bets = [...state.bets];
  const contrib = [...state.contrib];
  const folded = [...state.folded];
  const toAct = [...state.toAct];
  const actedAt = [...state.actedAt];
  const actions = [...state.actions];
  let { bet, raiseLevel, minRaise } = state;
  const pay = (amount: number) => {
    stacks[seat]! -= amount;
    bets[seat]! += amount;
    contrib[seat]! += amount;
  };
  switch (move.act) {
    case 'fold':
      folded[seat] = true;
      actions[seat] = { act: 'fold', amount: bets[seat]! };
      break;
    case 'check':
      actions[seat] = { act: 'check', amount: bets[seat]! };
      break;
    case 'call':
      pay(Math.min(bet - bets[seat]!, stacks[seat]!));
      actions[seat] = { act: stacks[seat] === 0 ? 'all-in' : 'call', amount: bets[seat]! };
      break;
    case 'raise': {
      const opened = bet === 0;
      pay(move.to - bets[seat]!);
      if (move.to - bet >= minRaise) {
        minRaise = move.to - bet;
        raiseLevel = move.to;
      }
      bet = move.to;
      actions[seat] = {
        act: stacks[seat] === 0 ? 'all-in' : opened ? 'bet' : 'raise',
        amount: move.to,
      };
      for (const s of seatsOf(state)) {
        if (s !== seat && state.dealt[s] && !folded[s] && stacks[s]! > 0) toAct[s] = true;
      }
      break;
    }
  }
  toAct[seat] = false;
  actedAt[seat] = raiseLevel;
  return proceed({
    ...state,
    turns: state.turns + 1,
    stacks,
    bets,
    contrib,
    folded,
    toAct,
    actedAt,
    actions,
    bet,
    raiseLevel,
    minRaise,
  });
}

/** After any step: the next to bet, else the board, the showdown, or the hand's end. */
function proceed(state: PokerState): PokerState {
  const live = liveSeats(state);
  if (live.length <= 1) return payout(state, live);
  const n = state.seats;
  const open = nextSeat(
    n,
    state.current,
    (s) => state.toAct[s]! && live.includes(s) && state.stacks[s]! > 0,
  );
  if (open >= 0) return { ...state, phase: 'bet', current: open };
  // The round of betting is over.
  const canBet = live.filter((s) => state.stacks[s]! > 0).length >= 2 && state.board.length < 5;
  if (canBet) return { ...state, phase: 'board', current: state.button };
  // Nobody can bet any more: hands up (all-ins show before the rest of the board), then deal out.
  const unshown = nextSeat(n, state.button, (s) => live.includes(s) && !state.shown[s]);
  if (unshown >= 0) return { ...state, phase: 'show', current: unshown };
  if (state.board.length < 5) return { ...state, phase: 'board', current: state.button };
  return payout(state, live);
}

/** A new round of betting after cards were turned up. */
function newStreet(state: PokerState, cards: readonly number[]): PokerState {
  const board = [...state.board, ...cards];
  const live = liveSeats(state);
  const withChips = live.filter((s) => state.stacks[s]! > 0);
  return proceed({
    ...state,
    board,
    bets: fill(state.seats, 0),
    bet: 0,
    raiseLevel: 0,
    minRaise: state.bb,
    actedAt: fill(state.seats, -1),
    toAct: seatsOf(state).map((s) => withChips.length >= 2 && withChips.includes(s)),
    actions: state.actions.map((a, s) =>
      state.folded[s] || (state.dealt[s] && state.stacks[s] === 0) ? a : null,
    ),
    current: state.button,
  });
}

/** Blinds, cards and the first round of betting. `deck` is null with friends (cards hidden). */
function startHand(state: PokerState, deck: number[] | null): PokerState {
  const n = state.seats;
  const alive = new Set(aliveSeats(state));
  const dealt = seatsOf(state).map((s) => alive.has(s) && state.stacks[s]! > 0);
  const count = dealt.filter(Boolean).length;
  const button = state.button;
  // Heads-up the button posts the small blind and acts first before the flop.
  const sbSeat = count === 2 ? button : nextSeat(n, button, (s) => dealt[s]!);
  const bbSeat = nextSeat(n, sbSeat, (s) => dealt[s]!);
  const stacks = [...state.stacks];
  const bets = fill(n, 0);
  const actions: (PokerAction | null)[] = fill(n, null);
  const post = (seat: number, amount: number, act: PokerAct) => {
    const paid = Math.min(amount, stacks[seat]!);
    stacks[seat]! -= paid;
    bets[seat] = paid;
    actions[seat] = { act: stacks[seat] === 0 ? 'all-in' : act, amount: paid };
  };
  post(sbSeat, state.sb, 'small blind');
  post(bbSeat, state.bb, 'big blind');
  const withChips = seatsOf(state).filter((s) => dealt[s] && stacks[s]! > 0);
  const toAct = seatsOf(state).map(
    (s) => dealt[s]! && stacks[s]! > 0 && (withChips.length >= 2 || bets[s]! < state.bb),
  );
  return proceed({
    ...state,
    dealt,
    folded: fill(n, false),
    stacks,
    bets,
    contrib: [...bets],
    bet: state.bb,
    raiseLevel: state.bb,
    minRaise: state.bb,
    actedAt: fill(n, -1),
    toAct,
    holes: seatsOf(state).map((s) =>
      dealt[s] ? (deck ? [deck[2 * s]!, deck[2 * s + 1]!] : [-1, -1]) : [],
    ),
    shown: fill(n, false),
    board: [],
    actions,
    deck: deck ?? [],
    current: bbSeat,
  });
}

/** Main and side pots: one per all-in level, each won by the best hand among those in it. */
export function buildPots(contrib: readonly number[], eligible: readonly number[]): PokerPot[] {
  const levels = [...new Set(eligible.map((s) => contrib[s]!).filter((v) => v > 0))].sort(
    (a, b) => a - b,
  );
  const pots: PokerPot[] = [];
  let previous = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contrib) amount += Math.max(0, Math.min(c, level) - previous);
    const seats = eligible.filter((s) => contrib[s]! >= level);
    const last = pots[pots.length - 1];
    if (last && last.seats.length === seats.length && last.seats.every((s, i) => s === seats[i])) {
      last.amount += amount;
    } else if (amount > 0) {
      pots.push({ amount, seats, winners: [] });
    }
    previous = level;
  }
  // Chips above every contender's (a player who bet more, then left): to the last pot.
  const total = contrib.reduce((a, b) => a + b, 0);
  const counted = pots.reduce((a, p) => a + p.amount, 0);
  if (pots.length > 0 && total > counted) pots[pots.length - 1]!.amount += total - counted;
  return pots;
}

/** The pots go to the best hands (an odd chip to the first winner left of the button). */
function payout(state: PokerState, live: readonly number[]): PokerState {
  if (live.length === 0) return voidHand(state);
  const n = state.seats;
  const showdown = live.length > 1;
  const scores = seatsOf(state).map((s) =>
    showdown && live.includes(s) ? handScore([...state.holes[s]!, ...state.board]) : null,
  );
  const pots = buildPots(state.contrib, live);
  const won = fill(n, 0);
  const order = (s: number) => (s - state.button - 1 + n) % n;
  for (const pot of pots) {
    let winners = pot.seats;
    if (winners.length > 1) {
      const best = Math.max(...winners.map((s) => scores[s] ?? -1));
      winners = winners.filter((s) => (scores[s] ?? -1) === best);
    }
    winners = [...winners].sort((a, b) => order(a) - order(b));
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    for (const w of winners) {
      won[w]! += share + (odd > 0 ? 1 : 0);
      odd--;
    }
    pot.winners = winners;
  }
  const last: PokerResult = {
    hand: state.hand,
    board: [...state.board],
    shown: seatsOf(state).map((s) => (showdown && live.includes(s) ? [...state.holes[s]!] : null)),
    scores,
    won,
    pots,
    void: false,
  };
  const paid: PokerState = { ...state, stacks: state.stacks.map((v, s) => v + won[s]!), last };
  return state.solo ? nextHand(paid) : { ...paid, phase: 'reveal', current: state.button };
}

/** The hand is called off (its dealer is gone): every bet goes back. */
function voidHand(state: PokerState): PokerState {
  const n = state.seats;
  return nextHand({
    ...state,
    stacks: state.stacks.map((v, s) => (state.left[s] ? v : v + state.contrib[s]!)),
    contrib: fill(n, 0),
    last: {
      hand: state.hand,
      board: [...state.board],
      shown: fill(n, null),
      scores: fill(n, null),
      won: fill(n, 0),
      pots: [],
      void: true,
    },
  });
}

/** Out of chips: out of the game. Then the next hand, or the end. */
function nextHand(state: PokerState): PokerState {
  const n = state.seats;
  const alreadyOut = new Set(state.busted.flat());
  const broke = seatsOf(state).filter(
    (s) => !state.left[s] && !alreadyOut.has(s) && state.stacks[s] === 0,
  );
  // Fewer chips at the start of the hand go out first; equal ones share a place.
  const busted = [...state.busted];
  const sorted = [...broke].sort((a, b) => state.contrib[a]! - state.contrib[b]!);
  for (const seat of sorted) {
    const group = busted[busted.length - 1];
    const sameHand = group && broke.includes(group[0]!);
    if (sameHand && state.contrib[group[0]!] === state.contrib[seat]) group.push(seat);
    else busted.push([seat]);
  }
  const base: PokerState = {
    ...state,
    busted,
    bets: fill(n, 0),
    contrib: fill(n, 0),
    toAct: fill(n, false),
    actedAt: fill(n, -1),
    bet: 0,
    raiseLevel: 0,
  };
  const alive = aliveSeats(base);
  const userOut = state.solo && broke.includes(SOLO_USER);
  if (alive.length <= 1 || userOut || state.hand + 1 >= POKER_MAX_HANDS) return finish(base);
  const hand = state.hand + 1;
  const button = nextSeat(n, state.button, (s) => alive.includes(s));
  const [sb, bb] = blindsFor(state.settings, hand);
  return {
    ...base,
    hand,
    button,
    sb,
    bb,
    minRaise: bb,
    phase: 'deal',
    current: button,
    dealt: fill(n, false),
    folded: fill(n, false),
    holes: fill(n, [] as number[]),
    shown: fill(n, false),
    board: [],
    actions: fill(n, null),
    commits: '',
    dealSalt: '',
    deck: [],
  };
}

/** Places: chips among those still in, then who went out last, then who left. */
function finish(state: PokerState): PokerState {
  const alive = aliveSeats(state).sort((a, b) => state.stacks[b]! - state.stacks[a]!);
  const groups: number[][] = [];
  for (const seat of alive) {
    const group = groups[groups.length - 1];
    if (group && state.stacks[group[0]!] === state.stacks[seat]) group.push(seat);
    else groups.push([seat]);
  }
  for (let i = state.busted.length - 1; i >= 0; i--) groups.push(state.busted[i]!);
  return { ...state, phase: 'done', ranks: placesFrom(state.seats, groups, state.leftOrder) };
}

function leave(state: PokerState, seat: number): PokerState {
  if (state.ranks || seat < 0 || seat >= state.seats || state.left[seat]) return state;
  const out = state.busted.flat().includes(seat);
  const left = state.left.map((l, i) => l || i === seat);
  const next: PokerState = {
    ...state,
    left,
    leftOrder: out ? state.leftOrder : [...state.leftOrder, seat],
  };
  if (out) return next;
  const alive = aliveSeats(next);
  if (alive.length <= 1) return finish(next);
  switch (state.phase) {
    case 'deal': {
      if (seat !== state.button) return next;
      const button = nextSeat(state.seats, seat, (s) => alive.includes(s));
      return { ...next, button, current: button };
    }
    case 'reveal':
      return seat === state.button ? nextHand({ ...next, unchecked: state.unchecked + 1 }) : next;
    case 'done':
      return next;
    default: {
      // The dealer is needed for the board and the check: the hand is called off.
      if (seat === state.button) return voidHand(next);
      if (!state.dealt[seat] || state.folded[seat]) return next;
      const folded: PokerState = {
        ...next,
        folded: state.folded.map((f, i) => f || i === seat),
        toAct: state.toAct.map((t, i) => t && i !== seat),
        actions: state.actions.map((a, i) => (i === seat ? { act: 'fold', amount: 0 } : a)),
      };
      return state.current === seat || liveSeats(folded).length <= 1 ? proceed(folded) : folded;
    }
  }
}

// Solo play

function setup(seats: number, settings: PokerSettings, first: number): PokerState {
  const [sb, bb] = blindsFor(settings, 0);
  return {
    ...turnCore(seats, first),
    solo: false,
    hand: 0,
    button: first,
    phase: 'deal',
    sb,
    bb,
    stacks: fill(seats, settings.chips),
    bets: fill(seats, 0),
    contrib: fill(seats, 0),
    dealt: fill(seats, false),
    folded: fill(seats, false),
    toAct: fill(seats, false),
    actedAt: fill(seats, -1),
    bet: 0,
    raiseLevel: 0,
    minRaise: bb,
    holes: fill(seats, [] as number[]),
    shown: fill(seats, false),
    board: [],
    actions: fill(seats, null),
    busted: [],
    last: null,
    commits: '',
    dealSalt: '',
    tips: fill(seats, ''),
    tipAt: fill(seats, CHAIN_LENGTH),
    badDeal: false,
    unchecked: 0,
    deck: [],
    rng: 0,
    settings,
  };
}

/** Solo: deal, turn up the next cards, or show the hands. */
function autoStep(state: PokerState): PokerState {
  const stepped = { ...state, turns: state.turns + 1 };
  switch (state.phase) {
    case 'deal': {
      const { rng, deck } = soloDeck(state.rng);
      return startHand({ ...stepped, rng }, deck);
    }
    case 'board':
      return newStreet(
        stepped,
        nextBoardPositions(state).map((p) => state.deck[p]!),
      );
    case 'show': {
      const live = liveSeats(state);
      return proceed({ ...stepped, shown: state.shown.map((v, s) => v || live.includes(s)) });
    }
    default:
      return state;
  }
}

const AUTO_PHASES: PokerPhase[] = ['deal', 'board', 'show'];

function isLegal(state: PokerState, move: PokerMove): boolean {
  if (state.ranks) return false;
  if ('act' in move) return isLegalBet(state, move);
  if ('next' in move) return state.solo && AUTO_PHASES.includes(state.phase);
  return false;
}

function apply(state: PokerState, move: PokerMove): PokerState {
  if (!isLegal(state, move)) return state;
  if ('act' in move) return act(state, move);
  return autoStep(state);
}

/** The bets on offer (empty while the seat's own cards are still unknown to this view). */
function legal(state: PokerState): PokerMove[] {
  if (state.ranks || state.phase !== 'bet') return [];
  const seat = state.current;
  if (state.holes[seat]?.[0] === undefined || state.holes[seat][0] < 0) return [];
  const owe = state.bet - state.bets[seat]!;
  const moves: PokerMove[] = owe > 0 ? [{ act: 'fold' }, { act: 'call' }] : [{ act: 'check' }];
  const range = raiseRange(state);
  if (range) {
    const sizes = [range.min, potRaise(state, 0.5), potRaise(state, 1), range.max]
      .map((v) => Math.min(range.max, Math.max(range.min, v)))
      .filter((v, i, all) => all.indexOf(v) === i)
      .sort((a, b) => a - b);
    for (const to of sizes) moves.push({ act: 'raise', to });
  }
  return moves;
}

// Friends: the dealer (ADR 0052, 0053)

const encoder = new TextEncoder();
const D_CHAIN = encoder.encode('pingdost/game/poker-chain/v1');
const D_SEED = encoder.encode('pingdost/game/poker-deal/v1');
const D_NONCE = encoder.encode('pingdost/game/poker-nonce/v1');
const D_CARD = encoder.encode('pingdost/game/poker-card/v1');

const chains = new Map<string, Uint8Array[]>();

/** A seat's dealing chain, from its seat secret (kept apart from its dice chain). */
function dealingChain(sha256: Sha256, seed: Uint8Array): Uint8Array[] {
  const key = toBase64(seed);
  let chain = chains.get(key);
  if (!chain) {
    chain = buildChain(sha256, sha256(concatBytes(D_CHAIN, seed)));
    if (chains.size >= 4) chains.delete(chains.keys().next().value!);
    chains.set(key, chain);
  }
  return chain;
}

/** The chain link that seeds hand `hand` (links are shown backwards, one per hand). */
const secretIndex = (hand: number) => CHAIN_LENGTH - 1 - hand;

/** What a seat publishes when it sits down: the end of its dealing chain (32 bytes). */
export function pokerSeatData(seed: Uint8Array, sha256: Sha256): Uint8Array {
  return dealingChain(sha256, seed)[CHAIN_LENGTH]!;
}

export function pokerSecret(sha256: Sha256, seed: Uint8Array, hand: number): Uint8Array {
  return dealingChain(sha256, seed)[secretIndex(hand)]!;
}

export interface PokerDeal {
  deck: number[];
  nonces: Uint8Array[];
  commitments: Uint8Array;
}

function cardCommitment(
  sha256: Sha256,
  gameId: Uint8Array,
  hand: number,
  p: number,
  card: number,
  nonce: Uint8Array,
): Uint8Array {
  return sha256(concatBytes(D_CARD, gameId, u32(hand), u32(p), Uint8Array.of(card), nonce)).slice(
    0,
    COMMIT_BYTES,
  );
}

/** A hand's whole deal from the dealer's secret and the salt: only the used positions count. */
export function pokerDeal(
  sha256: Sha256,
  secret: Uint8Array,
  salt: Uint8Array,
  gameId: Uint8Array,
  hand: number,
  seats: number,
): PokerDeal {
  const deck = shuffleDeck(
    hashStream(sha256, sha256(concatBytes(D_SEED, secret, salt, gameId, u32(hand)))),
  );
  const used = 2 * seats + 5;
  const nonces = Array.from({ length: used }, (_, p) =>
    sha256(concatBytes(D_NONCE, secret, u32(p))).slice(0, COMMIT_BYTES),
  );
  const commitments = new Uint8Array(used * COMMIT_BYTES);
  for (let p = 0; p < used; p++) {
    commitments.set(
      cardCommitment(sha256, gameId, hand, p, deck[p]!, nonces[p]!),
      p * COMMIT_BYTES,
    );
  }
  return { deck, nonces, commitments };
}

let dealCache: { key: string; deal: PokerDeal } | null = null;

/** The dealer's own view of its hand's deal. */
function dealerDeal(state: PokerState, knows: Knowledge): PokerDeal | null {
  if (!knows.seed || !state.dealSalt) return null;
  const key = `${toBase64(knows.seed)}|${toBase64(knows.gameId)}|${state.hand}|${state.dealSalt}`;
  if (dealCache?.key === key) return dealCache.deal;
  const deal = pokerDeal(
    knows.sha256,
    pokerSecret(knows.sha256, knows.seed, state.hand),
    fromBase64(state.dealSalt),
    knows.gameId,
    state.hand,
    state.seats,
  );
  dealCache = { key, deal };
  return deal;
}

function commitmentAt(state: PokerState, p: number): Uint8Array | null {
  if (!state.commits) return null;
  const all = fromBase64(state.commits);
  return all.length === (2 * state.seats + 5) * COMMIT_BYTES
    ? all.slice(p * COMMIT_BYTES, (p + 1) * COMMIT_BYTES)
    : null;
}

function proofHolds(
  state: PokerState,
  proof: { p: number; card: number; nonce: Uint8Array },
  sha256: Sha256,
  gameId: Uint8Array,
): boolean {
  const commitment = commitmentAt(state, proof.p);
  if (!commitment || !Number.isInteger(proof.card) || proof.card < 0 || proof.card > 51) {
    return false;
  }
  const made = cardCommitment(sha256, gameId, state.hand, proof.p, proof.card, proof.nonce);
  return sameBytes(made, commitment);
}

/** This seat's two cards with their nonces: from the private deal, or (the dealer) its secret. */
function myCards(
  state: PokerState,
  seat: number,
  knows: Knowledge,
): { p: number; card: number; nonce: Uint8Array }[] {
  if (!state.dealt[seat] || !state.commits) return [];
  let cards: { p: number; card: number; nonce: Uint8Array }[];
  if (seat === state.button) {
    const deal = dealerDeal(state, knows);
    if (!deal) return [];
    cards = [2 * seat, 2 * seat + 1].map((p) => ({
      p,
      card: deal.deck[p]!,
      nonce: deal.nonces[p]!,
    }));
  } else {
    const dealt = [...knows.deals]
      .reverse()
      .find((d) => d.round === state.hand && d.from === state.button);
    if (!dealt || dealt.data.length !== 2 * (1 + COMMIT_BYTES)) return [];
    cards = [0, 1].map((i) => ({
      p: 2 * seat + i,
      card: dealt.data[i * 17]!,
      nonce: dealt.data.slice(i * 17 + 1, i * 17 + 17),
    }));
  }
  // Only cards that match the dealer's commitments count (a wrong private deal shows nothing).
  return cards.every((c) => proofHolds(state, c, knows.sha256, knows.gameId)) ? cards : [];
}

/** Whether `reveal` is the dealer's chain link for this hand, below its last one shown. */
function chainHolds(state: PokerState, reveal: Uint8Array, sha256: Sha256): boolean {
  const seat = state.button;
  const tip = state.tips[seat];
  const at = state.tipAt[seat]!;
  const index = secretIndex(state.hand);
  if (!tip || reveal.length !== 32 || index < 0 || index >= at) return false;
  let link = reveal;
  for (let i = index; i < at; i++) link = chainStep(sha256, link);
  return sameBytes(link, fromBase64(tip));
}

function cardsMove(state: PokerState, move: { cards: PokerProof[] }, step: NetStep): boolean {
  const positions =
    state.phase === 'board'
      ? nextBoardPositions(state)
      : state.phase === 'show'
        ? [2 * state.current, 2 * state.current + 1]
        : [];
  if (positions.length === 0 || move.cards.length !== positions.length) return false;
  return move.cards.every(
    (c, i) =>
      c.p === positions[i] &&
      proofHolds(state, { ...c, nonce: fromBase64(c.nonce) }, step.sha256, step.gameId),
  );
}

function isLegalNet(state: PokerState, move: PokerMove, step: NetStep): boolean {
  if (state.ranks) return false;
  if ('act' in move) return isLegalBet(state, move);
  if ('deal' in move) {
    return (
      state.phase === 'deal' &&
      fromBase64(move.deal).length === (2 * state.seats + 5) * COMMIT_BYTES
    );
  }
  if ('cards' in move) return cardsMove(state, move, step);
  if ('reveal' in move) {
    return state.phase === 'reveal' && chainHolds(state, fromBase64(move.reveal), step.sha256);
  }
  // `muck` and `pass` are only ever played for an absent seat (proxy moves); `next` is solo.
  return false;
}

/** An absent seat's step, played by another player once its time ran out. */
function absent(state: PokerState, move: { muck: true } | { pass: true }): PokerState {
  const stepped = { ...state, turns: state.turns + 1 };
  if ('muck' in move) {
    if (state.phase !== 'show') return state;
    const seat = state.current;
    return proceed({
      ...stepped,
      folded: state.folded.map((f, i) => f || i === seat),
    });
  }
  switch (state.phase) {
    case 'deal':
      // The next seat deals; this hand number is skipped (its secret is never used).
      return nextHand(stepped);
    case 'board':
      return voidHand(stepped);
    case 'reveal':
      return nextHand({ ...stepped, unchecked: state.unchecked + 1 });
    default:
      return state;
  }
}

function applyNet(state: PokerState, move: PokerMove, step: NetStep): PokerState {
  if ('muck' in move || 'pass' in move) return absent(state, move);
  if (!isLegalNet(state, move, step)) return state;
  if ('act' in move) return act(state, move);
  const stepped = { ...state, turns: state.turns + 1 };
  if ('deal' in move) {
    return startHand(
      { ...stepped, commits: move.deal, dealSalt: toBase64(step.saltFor(state.button)) },
      null,
    );
  }
  if ('cards' in move) {
    if (state.phase === 'board')
      return newStreet(
        stepped,
        move.cards.map((c) => c.card),
      );
    const seat = state.current;
    return proceed({
      ...stepped,
      holes: state.holes.map((h, s) => (s === seat ? move.cards.map((c) => c.card) : h)),
      shown: state.shown.map((v, s) => v || s === seat),
    });
  }
  if ('reveal' in move) {
    // The dealer shows its secret: everyone recomputes the deal and checks every commitment.
    const deal = pokerDeal(
      step.sha256,
      fromBase64(move.reveal),
      fromBase64(state.dealSalt),
      step.gameId,
      state.hand,
      state.seats,
    );
    const honest = toBase64(deal.commitments) === state.commits;
    return nextHand({
      ...stepped,
      tips: state.tips.map((t, s) => (s === state.button ? move.reveal : t)),
      tipAt: state.tipAt.map((t, s) => (s === state.button ? secretIndex(state.hand) : t)),
      badDeal: state.badDeal || !honest,
    });
  }
  return state;
}

function holeData(deal: PokerDeal, seat: number): Uint8Array {
  const out = new Uint8Array(2 * (1 + COMMIT_BYTES));
  for (let i = 0; i < 2; i++) {
    out[i * 17] = deal.deck[2 * seat + i]!;
    out.set(deal.nonces[2 * seat + i]!, i * 17 + 1);
  }
  return out;
}

const proofOf = (deal: PokerDeal, p: number): PokerProof => ({
  p,
  card: deal.deck[p]!,
  nonce: toBase64(deal.nonces[p]!),
});

// Text

/** One line about a finished hand: "Bob wins 340 with a flush, ace high". */
export function pokerResultLine(result: PokerResult, name: (seat: number) => string): string {
  if (result.void) return 'Hand called off: every bet went back';
  const winners = result.won
    .map((amount, seat) => ({ seat, amount }))
    .filter((w) => w.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  if (winners.length === 0) return '';
  const verb = (seat: number) => (name(seat) === 'You' ? 'win' : 'wins');
  const how = (seat: number) => {
    const score = result.scores[seat];
    return score === null || score === undefined ? '' : ` with ${handPhrase(score)}`;
  };
  const first = winners[0]!;
  const split = result.pots.length === 1 && result.pots[0]!.winners.length > 1;
  if (split) {
    const names = result.pots[0]!.winners.map(name);
    const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${list} split ${formatChips(result.pots[0]!.amount)}${how(first.seat)}`;
  }
  const line = `${name(first.seat)} ${verb(first.seat)} ${formatChips(first.amount)}${how(first.seat)}`;
  const second = winners[1];
  return second
    ? `${line} · ${name(second.seat)} ${verb(second.seat)} ${formatChips(second.amount)}`
    : line;
}

/** A seat in the players' strip: "Dealer · 980 chips · bet 40", "Folded", "Out". */
export function pokerSeatLine(state: PokerState, seat: number): string {
  if (state.busted.flat().includes(seat)) return 'Out';
  const parts: string[] = [];
  if (seat === state.button && !state.ranks) parts.push('Dealer');
  parts.push(`${formatChips(state.stacks[seat]!)} chips`);
  if (state.dealt[seat] && state.folded[seat] && state.phase !== 'deal')
    return [...parts, 'folded'].join(' · ');
  if (state.dealt[seat] && state.stacks[seat] === 0 && state.phase !== 'deal') parts.push('all-in');
  else if (state.bets[seat]! > 0) parts.push(`bet ${formatChips(state.bets[seat]!)}`);
  return parts.join(' · ');
}

function note(state: PokerState, _you: number, name: (seat: number) => string): string | null {
  const dealer = name(state.button);
  const dealing = dealer === 'You' ? 'You are dealing…' : `${dealer} is dealing…`;
  switch (state.phase) {
    case 'deal':
      return state.last && state.last.hand === state.hand - 1
        ? pokerResultLine(state.last, name)
        : dealing;
    case 'board':
      return `Dealing the ${STREETS[Math.min(2, Math.max(0, state.board.length - 2))]}…`;
    case 'show':
      return 'Showdown';
    case 'reveal':
      return state.last ? pokerResultLine(state.last, name) : null;
    default:
      return null;
  }
}

// Saved games

function ints(raw: unknown, n: number, lo = -1): number[] | null {
  return Array.isArray(raw) && raw.length === n && raw.every((v) => Number.isInteger(v) && v >= lo)
    ? [...(raw as number[])]
    : null;
}

function bools(raw: unknown, n: number): boolean[] | null {
  return Array.isArray(raw) && raw.length === n && raw.every((v) => typeof v === 'boolean')
    ? [...raw]
    : null;
}

const PHASES: PokerPhase[] = ['deal', 'bet', 'board', 'show', 'reveal', 'done'];

function restore(raw: unknown): PokerState | null {
  const core = restoreCore(raw, 2, 6);
  if (!core) return null;
  const s = raw as Partial<PokerState>;
  const n = core.seats;
  const seat = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n;
  const stacks = ints(s.stacks, n, 0);
  const bets = ints(s.bets, n, 0);
  const contrib = ints(s.contrib, n, 0);
  const actedAt = ints(s.actedAt, n);
  const dealt = bools(s.dealt, n);
  const folded = bools(s.folded, n);
  const toAct = bools(s.toAct, n);
  const shown = bools(s.shown, n);
  if (!stacks || !bets || !contrib || !actedAt || !dealt || !folded || !toAct || !shown)
    return null;
  if (!PHASES.includes(s.phase as PokerPhase) || !seat(s.button)) return null;
  const numbers = [s.hand, s.sb, s.bb, s.bet, s.raiseLevel, s.minRaise, s.rng];
  if (!numbers.every((v) => Number.isInteger(v) && (v as number) >= 0)) return null;
  const card = (v: unknown) => Number.isInteger(v) && (v as number) >= -1 && (v as number) <= 51;
  if (!Array.isArray(s.holes) || s.holes.length !== n) return null;
  if (
    !s.holes.every((h) => Array.isArray(h) && (h.length === 0 || h.length === 2) && h.every(card))
  )
    return null;
  if (!Array.isArray(s.board) || s.board.length > 5 || !s.board.every(card)) return null;
  const deck = Array.isArray(s.deck) && s.deck.every(card) ? [...s.deck] : [];
  if (s.solo === true && s.phase !== 'deal' && s.phase !== 'done' && deck.length !== 52)
    return null;
  return {
    ...core,
    solo: s.solo === true,
    hand: s.hand!,
    button: s.button!,
    phase: s.phase as PokerPhase,
    sb: s.sb!,
    bb: s.bb!,
    stacks,
    bets,
    contrib,
    dealt,
    folded,
    toAct,
    actedAt,
    bet: s.bet!,
    raiseLevel: s.raiseLevel!,
    minRaise: s.minRaise!,
    holes: s.holes.map((h) => [...h]),
    shown,
    board: [...s.board],
    actions: Array.isArray(s.actions) && s.actions.length === n ? s.actions : fill(n, null),
    busted: Array.isArray(s.busted)
      ? s.busted.filter((g): g is number[] => Array.isArray(g) && g.every(seat))
      : [],
    last: s.last ?? null,
    commits: typeof s.commits === 'string' ? s.commits : '',
    dealSalt: typeof s.dealSalt === 'string' ? s.dealSalt : '',
    tips: Array.isArray(s.tips) && s.tips.length === n ? s.tips.map(String) : fill(n, ''),
    tipAt: ints(s.tipAt, n, 0) ?? fill(n, CHAIN_LENGTH),
    badDeal: s.badDeal === true,
    unchecked: Number.isInteger(s.unchecked) ? s.unchecked! : 0,
    deck,
    rng: s.rng!,
    settings: normalizeSettings(s.settings),
  };
}

function normalizeSettings(raw: unknown): PokerSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PokerSettings>;
  return {
    chips: POKER_CHIPS.includes(value.chips as (typeof POKER_CHIPS)[number]) ? value.chips! : 1000,
    risingBlinds: value.risingBlinds !== false,
  };
}

const ACT_CODES = { fold: 1, check: 2, call: 3, raise: 4 } as const;

export const POKER: TurnRules<PokerState, PokerMove, PokerSettings> = {
  id: 'poker',
  wireType: GameType.POKER,
  minPlayers: 2,
  maxPlayers: 6,
  dice: false,
  levels: true,
  turnMs: 30_000,
  defaultSettings: { chips: 1000, risingBlinds: true },
  normalizeSettings,
  settingsToWire: (settings) => ({
    case: 'poker',
    value: { startingChips: settings.chips, fixedBlinds: !settings.risingBlinds },
  }),
  settingsFromWire: (create) =>
    create.settings.case === 'poker'
      ? normalizeSettings({
          chips: create.settings.value.startingChips || 1000,
          risingBlinds: !create.settings.value.fixedBlinds,
        })
      : { chips: 1000, risingBlinds: true },
  setup,
  soloSetup: (state, random) => ({ ...state, solo: true, rng: random.int(0x7fffffff) + 1 }),
  auto: (state) =>
    state.solo && !state.ranks && AUTO_PHASES.includes(state.phase) ? { next: true } : null,
  legal,
  isLegal,
  apply,
  skip: (state) => state,
  leave,
  bot: (state: PokerState, level: BotLevel, random: Random) =>
    choosePokerMove(state, level, random),
  proxy: (state) =>
    state.phase === 'bet'
      ? state.bet === state.bets[state.current]
        ? { act: 'check' }
        : { act: 'fold' }
      : state.phase === 'show'
        ? { muck: true }
        : { pass: true },
  moveToWire: (move) => ({
    case: 'poker',
    value:
      'act' in move
        ? { action: ACT_CODES[move.act], amount: move.act === 'raise' ? move.to : 0 }
        : 'deal' in move
          ? { commitments: fromBase64(move.deal) }
          : 'cards' in move
            ? {
                positions: move.cards.map((c) => c.p),
                cards: move.cards.map((c) => c.card + 1),
                nonces: concatBytes(...move.cards.map((c) => fromBase64(c.nonce))),
              }
            : 'reveal' in move
              ? { reveal: fromBase64(move.reveal) }
              : 'muck' in move
                ? { muck: true }
                : 'pass' in move
                  ? { pass: true }
                  : {},
  }),
  moveFromWire: (wire) => {
    if (wire.play.case !== 'poker') return null;
    const v = wire.play.value;
    switch (v.action) {
      case 1:
        return { act: 'fold' };
      case 2:
        return { act: 'check' };
      case 3:
        return { act: 'call' };
      case 4:
        return v.amount > 0 ? { act: 'raise', to: v.amount } : null;
      default:
        break;
    }
    if (v.commitments.length > 0) return { deal: toBase64(v.commitments) };
    if (v.positions.length > 0) {
      const count = v.positions.length;
      if (v.cards.length !== count || v.nonces.length !== count * COMMIT_BYTES) return null;
      if (v.cards.some((c) => c < 1 || c > 52)) return null;
      return {
        cards: v.positions.map((p, i) => ({
          p,
          card: v.cards[i]! - 1,
          nonce: toBase64(v.nonces.slice(i * COMMIT_BYTES, (i + 1) * COMMIT_BYTES)),
        })),
      };
    }
    if (v.reveal.length > 0) return { reveal: toBase64(v.reveal) };
    if (v.muck) return { muck: true };
    if (v.pass) return { pass: true };
    return null;
  },
  sameMove: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  canonical: (s) =>
    [
      s.hand,
      s.button,
      s.phase,
      s.current,
      s.turns,
      s.sb,
      s.bb,
      s.stacks.join(','),
      s.bets.join(','),
      s.contrib.join(','),
      s.dealt.map(Number).join(''),
      s.folded.map(Number).join(''),
      s.toAct.map(Number).join(''),
      s.actedAt.join(','),
      s.bet,
      s.raiseLevel,
      s.minRaise,
      s.holes.map((h) => h.join('.')).join(','),
      s.shown.map(Number).join(''),
      s.board.join(','),
      s.busted.map((g) => g.join('.')).join(','),
      s.commits,
      s.dealSalt,
      s.tips.join(','),
      s.tipAt.join(','),
      s.badDeal ? 1 : 0,
      s.unchecked,
      s.left.map(Number).join(''),
      s.ranks?.join(',') ?? '-',
    ].join('|'),
  restore,
  sideName: (state, seat) => (seat === state.button ? 'Dealer' : `Seat ${seat + 1}`),
  rulesText: (settings) => [
    "Texas Hold'em, no limit, with play chips: no real money, nothing to buy and nothing to win.",
    `Everyone starts with ${formatChips(settings.chips)} chips. The blinds start at 10 and 20${settings.risingBlinds ? ` and double every ${BLINDS_EVERY} hands` : ''}.`,
    'You get two cards; five shared cards come in three steps (the flop, the turn, the river). The best five of your seven cards win.',
    'In each round of betting you check, bet, call, raise or fold. If you are all in, side pots keep it fair.',
    'The dealer button moves round the table. Run out of chips and you are out; the last player with chips wins.',
    'With friends: 30 seconds per decision; when time runs out you check, or fold if there is a bet to call. The dealer’s app deals, and shows the deal after each hand so everyone’s app can check it.',
  ],
  resultDetail: (state) => `After ${state.hand + 1} ${state.hand === 0 ? 'hand' : 'hands'}`,
  stepMs: (step, pace) => {
    if (step.kind === 'leave') return pace.read;
    const before = step.before;
    const after = step.state;
    if ((after.last?.hand ?? -1) !== (before.last?.hand ?? -1)) return pace.step + pace.read * 6;
    if (after.board.length > before.board.length) return pace.step * 2.5;
    if (before.phase === 'deal' && after.phase !== 'deal') return pace.step * 2;
    if (before.phase === 'show') return pace.step * 2;
    return pace.step;
  },
  note,
  hidden: {
    seatData: pokerSeatData,
    setupNet(seats, settings, first, net: NetSetup) {
      return {
        ...setup(seats, settings, first),
        tips: net.seatData.map((d) => (d.length === 32 ? toBase64(d) : '')),
      };
    },
    isLegalNet,
    applyNet,
    personalize(state, seat, knows) {
      if (seat < 0 || !state.dealt[seat] || (state.holes[seat]?.[0] ?? 0) >= 0) return state;
      if (state.phase === 'deal' || state.phase === 'done') return state;
      const mine = myCards(state, seat, knows);
      if (mine.length !== 2) return state;
      return {
        ...state,
        holes: state.holes.map((h, s) => (s === seat ? mine.map((c) => c.card) : h)),
      };
    },
    prove: (_state, move) => move,
    dealer: (state) =>
      state.ranks
        ? null
        : state.phase === 'deal' || state.phase === 'board' || state.phase === 'reveal'
          ? state.button
          : state.phase === 'show'
            ? state.current
            : null,
    deal(state, seat, knows, step) {
      const none = { move: { pass: true } as PokerMove, hands: [] };
      if (!knows.seed) return none;
      switch (state.phase) {
        case 'deal': {
          const deal = pokerDeal(
            step.sha256,
            pokerSecret(step.sha256, knows.seed, state.hand),
            step.saltFor(seat),
            step.gameId,
            state.hand,
            state.seats,
          );
          const alive = new Set(aliveSeats(state));
          return {
            move: { deal: toBase64(deal.commitments) },
            hands: seatsOf(state)
              .filter((s) => s !== seat && alive.has(s) && state.stacks[s]! > 0)
              .map((s) => ({ seat: s, round: state.hand, data: holeData(deal, s) })),
          };
        }
        case 'board': {
          const deal = dealerDeal(state, knows);
          if (!deal) return none;
          return {
            move: { cards: nextBoardPositions(state).map((p) => proofOf(deal, p)) },
            hands: [],
          };
        }
        case 'show': {
          const mine = myCards(state, seat, knows);
          return {
            move: { cards: mine.map((c) => ({ p: c.p, card: c.card, nonce: toBase64(c.nonce) })) },
            hands: [],
          };
        }
        case 'reveal':
          return {
            move: { reveal: toBase64(pokerSecret(step.sha256, knows.seed, state.hand)) },
            hands: [],
          };
        default:
          return none;
      }
    },
  },
};
