// Call Bridge (Phase 46): 4 players, 13 cards each, spades always trumps, 5 rounds. Each round
// every player calls how many tricks they will take (1–13); you must follow suit, and if you
// can't you must play a spade if you have one. Making your call scores the call plus a tenth per
// extra trick; falling short scores minus the call. Highest total after 5 rounds wins.
//
// With friends a rotating dealer deals each round (ADR 0052): the deal comes from the dealer's
// secret for that round (committed at join) and a salt it didn't choose; it publishes a
// commitment per card and sends each seat its cards with their nonces privately; every card
// played is proved; at the round's end the dealer shows its secret and everyone checks the deal
// and any revoke.
import { GameType, fromBase64, toBase64 } from '@pingdost/protocol';

import { concatBytes, hashStream, shuffleDeck, soloDeck, u32 } from '../core/deck';
import { sameBytes, type Sha256 } from '../core/fair-dice';
import type { Random } from '../core/random';
import {
  placesByScore,
  restoreCore,
  turnCore,
  type Knowledge,
  type NetSetup,
  type NetStep,
  type TurnCore,
  type TurnRules,
} from '../core/turn';
import type { BotLevel } from '../core/types';

export const BRIDGE_ROUNDS = 5;
export const SPADES = 0;
const COMMIT_BYTES = 16;
const HAND = 13;

/** Card 0–51: suit (0 spades, 1 hearts, 2 diamonds, 3 clubs) × 13 + rank (0 = 2 … 12 = ace). */
export const suitOf = (card: number) => Math.floor(card / 13);
export const rankOf = (card: number) => card % 13;
const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_WORDS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king', 'ace'];
const SUIT_WORDS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const rankLabel = (card: number) => RANK_LABELS[rankOf(card)]!;
export const bridgeCardName = (card: number) =>
  `${RANK_WORDS[rankOf(card)]} of ${SUIT_WORDS[suitOf(card)]}`;

export type BridgeSettings = Record<string, never>;
export type BridgePhase = 'deal' | 'call' | 'play' | 'reveal' | 'done';

/** A card in a hand: its position in the dealt deck, and the card (−1 while hidden). */
export interface BridgeCard {
  p: number;
  card: number;
}

export interface BridgePlay {
  seat: number;
  card: number;
  p: number;
}

export interface BridgeRound {
  dealer: number;
  calls: number[];
  tricks: number[];
  /** Tenths of a point. */
  points: number[];
  /** Seats caught not following suit (or not trumping) when the deal was shown. */
  revoked: number[];
}

export interface BridgeState extends TurnCore {
  /** 0-based; the game ends after `BRIDGE_ROUNDS`. */
  round: number;
  dealer: number;
  phase: BridgePhase;
  hands: BridgeCard[][];
  /** This round's calls (0: not yet). */
  calls: number[];
  tricks: number[];
  trick: BridgePlay[];
  leader: number;
  lastTrick: { plays: BridgePlay[]; winner: number } | null;
  /** This round's cards in the order played. */
  played: BridgePlay[];
  /** Totals in tenths of a point. */
  scores: number[];
  history: BridgeRound[];
  /** With friends: this round's per-card commitments and deal salt (base64), each seat's dealer commitments. */
  commits: string;
  dealSalt: string;
  dealerCommits: string[];
  /** A dealer's shown secret did not match its deal. */
  badDeal: boolean;
  /** Solo: the random state the next deal comes from. */
  rng: number;
  settings: BridgeSettings;
}

export type BridgeMove =
  | { call: number }
  | { play: number; card: number; nonce?: string }
  | { deal: string }
  | { reveal: string };

const encoder = new TextEncoder();
const D_SECRET = encoder.encode('pingdost/game/deal-secret/v1');
const D_COMMIT = encoder.encode('pingdost/game/deal-commit/v1');
const D_SEED = encoder.encode('pingdost/game/deal-seed/v1');
const D_NONCE = encoder.encode('pingdost/game/deal-nonce/v1');
const D_CARD = encoder.encode('pingdost/game/deal-card/v1');

const concat = concatBytes;
const shuffle = shuffleDeck;

// The deal

export function dealerSecret(sha256: Sha256, seed: Uint8Array, round: number): Uint8Array {
  return sha256(concat(D_SECRET, seed, u32(round)));
}

const dealerCommitment = (sha256: Sha256, secret: Uint8Array) =>
  sha256(concat(D_COMMIT, secret)).slice(0, COMMIT_BYTES);

/** The dealer commitments a seat publishes at join: one per round it may deal. */
export function bridgeSeatData(seed: Uint8Array, sha256: Sha256): Uint8Array {
  const out = new Uint8Array(BRIDGE_ROUNDS * COMMIT_BYTES);
  for (let r = 0; r < BRIDGE_ROUNDS; r++) {
    out.set(dealerCommitment(sha256, dealerSecret(sha256, seed, r)), r * COMMIT_BYTES);
  }
  return out;
}

interface Deal {
  deck: number[];
  nonces: Uint8Array[];
  commitments: Uint8Array;
}

/** The whole deal of a round from the dealer's secret and the deal salt. */
export function dealFrom(
  sha256: Sha256,
  secret: Uint8Array,
  salt: Uint8Array,
  gameId: Uint8Array,
  round: number,
): Deal {
  const deck = shuffle(
    hashStream(sha256, sha256(concat(D_SEED, secret, salt, gameId, u32(round)))),
  );
  const nonces = deck.map((_, p) => sha256(concat(D_NONCE, secret, u32(p))).slice(0, COMMIT_BYTES));
  const commitments = new Uint8Array(52 * COMMIT_BYTES);
  deck.forEach((card, p) =>
    commitments.set(cardCommitment(sha256, gameId, round, p, card, nonces[p]!), p * COMMIT_BYTES),
  );
  return { deck, nonces, commitments };
}

function cardCommitment(
  sha256: Sha256,
  gameId: Uint8Array,
  round: number,
  p: number,
  card: number,
  nonce: Uint8Array,
): Uint8Array {
  return sha256(concat(D_CARD, gameId, u32(round), u32(p), Uint8Array.of(card), nonce)).slice(
    0,
    COMMIT_BYTES,
  );
}

/** Seat s holds positions 13s … 13s + 12 of the dealt deck. */
const seatOfPosition = (p: number) => Math.floor(p / HAND);

/** A seat's private hand: 13 × (card, 16-byte nonce). */
function handData(deal: Deal, seat: number): Uint8Array {
  const out = new Uint8Array(HAND * (1 + COMMIT_BYTES));
  for (let i = 0; i < HAND; i++) {
    const p = seat * HAND + i;
    out[i * 17] = deal.deck[p]!;
    out.set(deal.nonces[p]!, i * 17 + 1);
  }
  return out;
}

function readHand(
  data: Uint8Array,
  seat: number,
): { p: number; card: number; nonce: Uint8Array }[] {
  if (data.length !== HAND * 17) return [];
  return Array.from({ length: HAND }, (_, i) => ({
    p: seat * HAND + i,
    card: data[i * 17]!,
    nonce: data.slice(i * 17 + 1, i * 17 + 17),
  }));
}

// Rules on the public state

/** The cards a hand may play now: follow suit; if void, a spade if you have one. */
export function playableCards(hand: readonly number[], trick: readonly BridgePlay[]): number[] {
  if (trick.length === 0) return [...hand];
  const led = suitOf(trick[0]!.card);
  const follow = hand.filter((c) => suitOf(c) === led);
  if (follow.length > 0) return follow;
  const spades = hand.filter((c) => suitOf(c) === SPADES);
  return spades.length > 0 ? spades : [...hand];
}

/** Who takes a full trick: the highest spade, else the highest card of the suit led. */
export function trickWinner(trick: readonly BridgePlay[]): number {
  const led = suitOf(trick[0]!.card);
  let best = trick[0]!;
  for (const play of trick.slice(1)) {
    const a = suitOf(best.card);
    const b = suitOf(play.card);
    const beats =
      (b === SPADES && a !== SPADES) || (b === a && rankOf(play.card) > rankOf(best.card));
    if (beats && (b === led || b === SPADES)) best = play;
  }
  return best.seat;
}

export function roundPoints(call: number, tricks: number): number {
  return tricks >= call ? 10 * call + (tricks - call) : -10 * call;
}

const next = (seat: number) => (seat + 1) % 4;

function newRound(state: BridgeState, deck: number[] | null): BridgeState {
  const hands = Array.from({ length: 4 }, (_, s) =>
    Array.from({ length: HAND }, (_, i) => {
      const p = s * HAND + i;
      return { p, card: deck ? deck[p]! : -1 };
    }),
  );
  const first = next(state.dealer);
  return {
    ...state,
    phase: 'call',
    hands,
    calls: [0, 0, 0, 0],
    tricks: [0, 0, 0, 0],
    trick: [],
    leader: first,
    current: first,
    lastTrick: null,
    played: [],
  };
}

/** The round is over: points, history, then the next round (solo deals it) or the end. */
function endRound(state: BridgeState, revoked: number[], solo: boolean): BridgeState {
  const points = state.calls.map((call, s) =>
    revoked.includes(s) ? -10 * call : roundPoints(call, state.tricks[s]!),
  );
  const scores = state.scores.map((v, s) => v + points[s]!);
  const history = [
    ...state.history,
    { dealer: state.dealer, calls: state.calls, tricks: state.tricks, points, revoked },
  ];
  const done: BridgeState = { ...state, scores, history, round: state.round + 1, trick: [] };
  if (done.round >= BRIDGE_ROUNDS) {
    return { ...done, phase: 'done', ranks: placesByScore(done, scores) };
  }
  const dealer = next(state.dealer);
  if (solo) {
    const { rng, deck } = soloDeck(state.rng);
    return newRound({ ...done, dealer, rng }, deck);
  }
  return {
    ...done,
    dealer,
    phase: 'deal',
    current: dealer,
    hands: [[], [], [], []],
    commits: '',
    dealSalt: '',
  };
}

function setup(seats: number, settings: BridgeSettings, first: number): BridgeState {
  return {
    ...turnCore(seats, first),
    round: 0,
    dealer: first,
    phase: 'deal',
    hands: [[], [], [], []],
    calls: [0, 0, 0, 0],
    tricks: [0, 0, 0, 0],
    trick: [],
    leader: next(first),
    lastTrick: null,
    played: [],
    scores: [0, 0, 0, 0],
    history: [],
    commits: '',
    dealSalt: '',
    dealerCommits: ['', '', '', ''],
    badDeal: false,
    rng: 0,
    settings,
  };
}

function knownHand(state: BridgeState, seat: number): number[] {
  return state.hands[seat]!.filter((c) => c.card >= 0).map((c) => c.card);
}

function legal(state: BridgeState): BridgeMove[] {
  if (state.ranks) return [];
  if (state.phase === 'call') return Array.from({ length: 13 }, (_, i) => ({ call: i + 1 }));
  if (state.phase !== 'play') return [];
  const hand = state.hands[state.current]!;
  const allowed = new Set(playableCards(knownHand(state, state.current), state.trick));
  return hand
    .filter((c) => c.card >= 0 && allowed.has(c.card))
    .map((c) => ({ play: c.p, card: c.card }));
}

/** A card played: shared by the solo and the friend paths. */
function playCard(
  state: BridgeState,
  move: { play: number; card: number },
  solo: boolean,
): BridgeState {
  const seat = state.current;
  const hands = state.hands.map((h, s) => (s === seat ? h.filter((c) => c.p !== move.play) : h));
  const play = { seat, card: move.card, p: move.play };
  const trick = [...state.trick, play];
  const played = [...state.played, play];
  let next_: BridgeState = { ...state, hands, trick, played, turns: state.turns + 1 };
  if (trick.length < 4) return { ...next_, current: next(seat) };
  const winner = trickWinner(trick);
  const tricks = next_.tricks.map((t, s) => (s === winner ? t + 1 : t));
  next_ = {
    ...next_,
    tricks,
    trick: [],
    lastTrick: { plays: trick, winner },
    leader: winner,
    current: winner,
  };
  if (hands.every((h) => h.length === 0)) {
    return solo ? endRound(next_, [], true) : { ...next_, phase: 'reveal', current: next_.dealer };
  }
  return next_;
}

function callMade(state: BridgeState, call: number): BridgeState {
  const seat = state.current;
  const calls = state.calls.map((c, s) => (s === seat ? call : c));
  const next_: BridgeState = { ...state, calls, turns: state.turns + 1 };
  if (calls.every((c) => c > 0)) return { ...next_, phase: 'play', current: state.leader };
  return { ...next_, current: next(seat) };
}

function isLegal(state: BridgeState, move: BridgeMove): boolean {
  if (state.ranks) return false;
  if ('call' in move) {
    return (
      state.phase === 'call' && Number.isInteger(move.call) && move.call >= 1 && move.call <= 13
    );
  }
  if ('play' in move) {
    if (state.phase !== 'play') return false;
    const owned = state.hands[state.current]!.find((c) => c.p === move.play);
    if (!owned || owned.card !== move.card) return false;
    return playableCards(knownHand(state, state.current), state.trick).includes(move.card);
  }
  return false;
}

function apply(state: BridgeState, move: BridgeMove): BridgeState {
  if (!isLegal(state, move)) return state;
  if ('call' in move) return callMade(state, move.call);
  if ('play' in move) return playCard(state, move, true);
  return state;
}

// Computer players: they see their own hand and every card played so far.

export function estimateCall(hand: readonly number[]): number {
  let total = 0;
  for (let suit = 0; suit < 4; suit++) {
    const cards = hand
      .filter((c) => suitOf(c) === suit)
      .map(rankOf)
      .sort((a, b) => b - a);
    const length = cards.length;
    if (suit === SPADES) {
      if (cards.includes(12)) total += 1;
      if (cards.includes(11)) total += 0.9;
      if (cards.includes(10)) total += 0.6;
      total += Math.max(0, length - 3) * 0.8;
    } else {
      if (cards.includes(12)) total += 1;
      if (cards.includes(11) && length >= 2 && length <= 5) total += 0.7;
      if (cards.includes(10) && length >= 3 && length <= 4) total += 0.3;
    }
  }
  const spades = hand.filter((c) => suitOf(c) === SPADES).length;
  for (let suit = 1; suit < 4; suit++) {
    const length = hand.filter((c) => suitOf(c) === suit).length;
    if (length <= 1 && spades >= 2) total += 0.5;
  }
  return total;
}

/** Cards nobody has played yet that this seat doesn't hold. */
function unseen(state: BridgeState, seat: number): number[] {
  const out = new Set(Array.from({ length: 52 }, (_, i) => i));
  for (const c of knownHand(state, seat)) out.delete(c);
  for (const p of state.played) out.delete(p.card);
  for (const p of state.trick) out.delete(p.card);
  return [...out];
}

/** Whether `card` is the highest of its suit still out (a sure winner of its suit). */
function isBoss(card: number, out: readonly number[]): boolean {
  return !out.some((c) => suitOf(c) === suitOf(card) && rankOf(c) > rankOf(card));
}

function beats(card: number, trick: readonly BridgePlay[]): boolean {
  if (trick.length === 0) return true;
  return trickWinner([...trick, { seat: -1, card, p: -1 }]) === -1;
}

/** The Medium player's card (also Hard's model of everyone in its simulations). */
function mediumCard(
  hand: readonly number[],
  trick: readonly BridgePlay[],
  out: readonly number[],
  need: number,
): number {
  const options = playableCards(hand, trick);
  // The lowest card, keeping spades (trumps) for later.
  const weight = (c: number) => (suitOf(c) === SPADES ? 100 : 0) + rankOf(c);
  const low = (cards: number[]) => cards.reduce((a, b) => (weight(b) < weight(a) ? b : a));
  const high = (cards: number[]) => cards.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));
  if (trick.length === 0) {
    if (need > 0) {
      const bosses = options.filter((c) => isBoss(c, out));
      const plain = bosses.filter((c) => suitOf(c) !== SPADES);
      if (plain.length > 0) return high(plain);
      if (bosses.length > 0) return high(bosses);
    }
    const nonSpades = options.filter((c) => suitOf(c) !== SPADES);
    return low(nonSpades.length > 0 ? nonSpades : options);
  }
  const winners = options.filter((c) => beats(c, trick));
  if (need > 0 && winners.length > 0) {
    if (trick.length === 3) return low(winners);
    const sure = winners.filter((c) => isBoss(c, out) || suitOf(c) === SPADES);
    return sure.length > 0 ? low(sure) : low(winners);
  }
  const losers = options.filter((c) => !beats(c, trick));
  return losers.length > 0 ? high(losers) : low(options);
}

function chooseCard(state: BridgeState, level: BotLevel, random: Random): BridgeMove {
  const seat = state.current;
  const moves = legal(state) as { play: number; card: number }[];
  if (moves.length === 1 || level === 'easy') return moves[random.int(moves.length)]!;
  const hand = knownHand(state, seat);
  const out = unseen(state, seat);
  const need = state.calls[seat]! - state.tricks[seat]!;
  const byCard = (card: number) => moves.find((m) => m.card === card)!;
  if (level === 'medium') return byCard(mediumCard(hand, state.trick, out, need));

  // Hard: sampled hands. Deal the unseen cards to the others at random (respecting suits they
  // showed out of), play the round out with the Medium player for everyone, and keep the card
  // with the best average result for this seat.
  const voids = voidsOf(state);
  const samples = 16;
  let best = -Infinity;
  let pick = moves[0]!;
  for (const move of moves) {
    let total = 0;
    for (let s = 0; s < samples; s++) {
      const hands = sampleHands(state, seat, out, voids, random);
      total += simulate(state, seat, move.card, hands);
    }
    if (total > best) {
      best = total;
      pick = move;
    }
  }
  return pick;
}

/** Suits each seat is known to lack (it didn't follow, or didn't trump when void). */
function voidsOf(state: BridgeState): boolean[][] {
  const voids = Array.from({ length: 4 }, () => [false, false, false, false]);
  const tricks: BridgePlay[][] = [];
  for (let i = 0; i < state.played.length; i += 4) tricks.push(state.played.slice(i, i + 4));
  if (state.trick.length > 0) tricks.push(state.trick);
  for (const trick of tricks) {
    const led = suitOf(trick[0]!.card);
    for (const play of trick.slice(1)) {
      const suit = suitOf(play.card);
      if (suit !== led) {
        voids[play.seat]![led] = true;
        if (suit !== SPADES) voids[play.seat]![SPADES] = true;
      }
    }
  }
  return voids;
}

function sampleHands(
  state: BridgeState,
  seat: number,
  out: readonly number[],
  voids: boolean[][],
  random: Random,
): number[][] {
  const sizes = state.hands.map((h) => h.length);
  for (let attempt = 0; attempt < 20; attempt++) {
    const pool = [...out];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = random.int(i + 1);
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const hands: number[][] = [[], [], [], []];
    hands[seat] = knownHand(state, seat);
    let ok = true;
    for (const card of pool) {
      const takers = [0, 1, 2, 3].filter(
        (s) => s !== seat && hands[s]!.length < sizes[s]! && !voids[s]![suitOf(card)],
      );
      const fallback = [0, 1, 2, 3].filter((s) => s !== seat && hands[s]!.length < sizes[s]!);
      const choices = takers.length > 0 ? takers : fallback;
      if (choices.length === 0) {
        ok = false;
        break;
      }
      hands[choices[random.int(choices.length)]!]!.push(card);
    }
    if (ok) return hands;
  }
  return [knownHand(state, seat), [], [], []];
}

/** This seat's round points after playing `card` and the Medium player for the rest. */
function simulate(state: BridgeState, seat: number, card: number, hands: number[][]): number {
  const h = hands.map((x) => [...x]);
  const tricks = [...state.tricks];
  const played: number[] = [...state.played.map((p) => p.card), ...state.trick.map((p) => p.card)];
  let trick = [...state.trick];
  let current = seat;
  let first = true;
  for (let guard = 0; guard < 60; guard++) {
    if (h.every((x) => x.length === 0) && trick.length === 0) break;
    const hand = h[current]!;
    if (hand.length === 0) break;
    const out = Array.from({ length: 52 }, (_, i) => i).filter(
      (c) => !played.includes(c) && !hand.includes(c),
    );
    const choice = first
      ? card
      : mediumCard(hand, trick, out, state.calls[current]! - tricks[current]!);
    first = false;
    h[current] = hand.filter((c) => c !== choice);
    played.push(choice);
    trick.push({ seat: current, card: choice, p: -1 });
    if (trick.length === 4) {
      const winner = trickWinner(trick);
      tricks[winner]! += 1;
      trick = [];
      current = winner;
    } else {
      current = next(current);
    }
  }
  return roundPoints(state.calls[seat]!, tricks[seat]!);
}

export function chooseBridgeMove(state: BridgeState, level: BotLevel, random: Random): BridgeMove {
  if (state.phase === 'call') {
    const estimate = estimateCall(knownHand(state, state.current));
    const wobble = level === 'easy' ? random.int(3) - 1 : 0;
    const base = level === 'hard' ? Math.floor(estimate + 0.35) : Math.round(estimate);
    return { call: Math.min(13, Math.max(1, base + wobble)) };
  }
  return chooseCard(state, level, random);
}

// Friends: the dealer (ADR 0052)

function dealerKnows(state: BridgeState, knows: Knowledge): Deal | null {
  if (!knows.seed || !state.dealSalt) return null;
  return dealFrom(
    knows.sha256,
    dealerSecret(knows.sha256, knows.seed, state.round),
    fromBase64(state.dealSalt),
    knows.gameId,
    state.round,
  );
}

/** This seat's cards with their nonces for the round, from the private deal or its own secret. */
function myCards(
  state: BridgeState,
  seat: number,
  knows: Knowledge,
): { p: number; card: number; nonce: Uint8Array }[] {
  if (seat === state.dealer) {
    const deal = dealerKnows(state, knows);
    if (!deal) return [];
    return Array.from({ length: HAND }, (_, i) => {
      const p = seat * HAND + i;
      return { p, card: deal.deck[p]!, nonce: deal.nonces[p]! };
    });
  }
  const dealt = [...knows.deals]
    .reverse()
    .find((d) => d.round === state.round && d.from === state.dealer);
  return dealt ? readHand(dealt.data, seat) : [];
}

function commitmentAt(state: BridgeState, p: number): Uint8Array | null {
  if (!state.commits) return null;
  const all = fromBase64(state.commits);
  return all.length === 52 * COMMIT_BYTES
    ? all.slice(p * COMMIT_BYTES, (p + 1) * COMMIT_BYTES)
    : null;
}

/** Revokes: replays the round with every hand known and finds plays that broke the rules. */
function findRevokes(deck: readonly number[], played: readonly BridgePlay[]): number[] {
  const hands = Array.from({ length: 4 }, (_, s) => deck.slice(s * HAND, (s + 1) * HAND));
  const revoked = new Set<number>();
  for (let i = 0; i < played.length; i += 4) {
    const trick: BridgePlay[] = [];
    for (const play of played.slice(i, i + 4)) {
      if (!playableCards(hands[play.seat]!, trick).includes(play.card)) revoked.add(play.seat);
      hands[play.seat] = hands[play.seat]!.filter((c) => c !== play.card);
      trick.push(play);
    }
  }
  return [...revoked];
}

function isLegalNet(state: BridgeState, move: BridgeMove, step: NetStep): boolean {
  if (state.ranks) return false;
  if ('deal' in move) {
    return state.phase === 'deal' && fromBase64(move.deal).length === 52 * COMMIT_BYTES;
  }
  if ('reveal' in move) {
    if (state.phase !== 'reveal') return false;
    const commits = state.dealerCommits[state.dealer];
    if (!commits) return false;
    const expected = fromBase64(commits).slice(
      state.round * COMMIT_BYTES,
      (state.round + 1) * COMMIT_BYTES,
    );
    return (
      expected.length === COMMIT_BYTES &&
      sameBytes(dealerCommitment(step.sha256, fromBase64(move.reveal)), expected)
    );
  }
  if ('call' in move) return isLegal(state, move);
  if (state.phase !== 'play' || !move.nonce) return false;
  if (!Number.isInteger(move.card) || move.card < 0 || move.card > 51) return false;
  if (seatOfPosition(move.play) !== state.current) return false;
  if (!state.hands[state.current]!.some((c) => c.p === move.play)) return false;
  const commitment = commitmentAt(state, move.play);
  if (!commitment) return false;
  const proof = cardCommitment(
    step.sha256,
    step.gameId,
    state.round,
    move.play,
    move.card,
    fromBase64(move.nonce),
  );
  if (!sameBytes(proof, commitment)) return false;
  // What can be checked now: a card of the suit led is always fine; anything else is checked
  // against the whole hand when the dealer shows the deal.
  return true;
}

function applyNet(state: BridgeState, move: BridgeMove, step: NetStep): BridgeState {
  if (!isLegalNet(state, move, step)) return state;
  if ('deal' in move) {
    const dealt: BridgeState = {
      ...state,
      commits: move.deal,
      dealSalt: toBase64(step.saltFor(state.dealer)),
      turns: state.turns + 1,
    };
    return newRound(dealt, null);
  }
  if ('call' in move) return callMade(state, move.call);
  if ('play' in move) return playCard(state, move, false);
  // The dealer shows its secret: check the deal it committed to, then look for revokes.
  const deal = dealFrom(
    step.sha256,
    fromBase64(move.reveal),
    fromBase64(state.dealSalt),
    step.gameId,
    state.round,
  );
  const honest = toBase64(deal.commitments) === state.commits;
  const revoked = honest ? findRevokes(deal.deck, state.played) : [];
  return endRound(
    { ...state, turns: state.turns + 1, badDeal: state.badDeal || !honest },
    revoked,
    false,
  );
}

const SEAT_NAMES = ['North', 'East', 'South', 'West'];

export const CALL_BRIDGE: TurnRules<BridgeState, BridgeMove, BridgeSettings> = {
  id: 'call-bridge',
  wireType: GameType.CALL_BRIDGE,
  minPlayers: 4,
  maxPlayers: 4,
  dice: false,
  levels: true,
  turnMs: null,
  defaultSettings: {},
  normalizeSettings: () => ({}),
  settingsToWire: () => ({ case: 'callBridge', value: {} }),
  settingsFromWire: () => ({}),
  setup,
  soloSetup(state, random) {
    const { rng, deck } = soloDeck(random.int(0x7fffffff) + 1);
    return newRound({ ...state, rng }, deck);
  },
  legal,
  isLegal,
  apply,
  skip: (state) => state,
  leave: (state, seat) => {
    if (state.ranks || state.left[seat]) return state;
    const left = state.left.map((l, i) => l || i === seat);
    const next_: BridgeState = {
      ...state,
      left,
      leftOrder: [...state.leftOrder, seat],
      phase: 'done',
    };
    // Call Bridge needs four: the game ends, placed by the totals so far.
    return { ...next_, ranks: placesByScore(next_, state.scores) };
  },
  bot: chooseBridgeMove,
  moveToWire: (move) => ({
    case: 'callBridge',
    value:
      'call' in move
        ? { call: move.call }
        : 'play' in move
          ? {
              position: move.play,
              card: move.card + 1,
              nonce: move.nonce ? fromBase64(move.nonce) : new Uint8Array(0),
            }
          : 'deal' in move
            ? { commitments: fromBase64(move.deal) }
            : { reveal: fromBase64(move.reveal) },
  }),
  moveFromWire: (wire) => {
    if (wire.play.case !== 'callBridge') return null;
    const v = wire.play.value;
    if (v.call > 0) return { call: v.call };
    if (v.card > 0) {
      return {
        play: v.position,
        card: v.card - 1,
        ...(v.nonce.length > 0 ? { nonce: toBase64(v.nonce) } : {}),
      };
    }
    if (v.commitments.length > 0) return { deal: toBase64(v.commitments) };
    if (v.reveal.length > 0) return { reveal: toBase64(v.reveal) };
    return null;
  },
  sameMove: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  canonical: (s) =>
    [
      s.round,
      s.dealer,
      s.phase,
      s.current,
      s.turns,
      s.hands.map((h) => h.map((c) => `${c.p}.${c.card}`).join(',')).join(';'),
      s.calls.join(','),
      s.tricks.join(','),
      s.played.map((p) => `${p.seat}.${p.card}`).join(','),
      s.trick.map((p) => `${p.seat}.${p.card}`).join(','),
      s.scores.join(','),
      s.commits,
      s.dealSalt,
      s.badDeal ? 1 : 0,
      s.left.map(Number).join(''),
      s.ranks?.join(',') ?? '-',
    ].join('|'),
  restore(raw) {
    const core = restoreCore(raw, 4, 4);
    if (!core) return null;
    const s = raw as Partial<BridgeState>;
    const phases: BridgePhase[] = ['deal', 'call', 'play', 'reveal', 'done'];
    if (!phases.includes(s.phase as BridgePhase) || !Array.isArray(s.hands) || s.hands.length !== 4)
      return null;
    if (!Number.isInteger(s.round) || !Number.isInteger(s.dealer)) return null;
    const four = (v: unknown) =>
      Array.isArray(v) && v.length === 4 && v.every(Number.isInteger) ? (v as number[]) : null;
    const calls = four(s.calls);
    const tricks = four(s.tricks);
    const scores = four(s.scores);
    if (!calls || !tricks || !scores) return null;
    return {
      ...core,
      round: s.round!,
      dealer: s.dealer!,
      phase: s.phase as BridgePhase,
      hands: s.hands.map((h) =>
        Array.isArray(h) ? h.map((c: BridgeCard) => ({ p: c.p, card: c.card })) : [],
      ),
      calls,
      tricks,
      trick: Array.isArray(s.trick) ? s.trick : [],
      leader: Number.isInteger(s.leader) ? s.leader! : 0,
      lastTrick: s.lastTrick ?? null,
      played: Array.isArray(s.played) ? s.played : [],
      scores,
      history: Array.isArray(s.history) ? s.history : [],
      commits: typeof s.commits === 'string' ? s.commits : '',
      dealSalt: typeof s.dealSalt === 'string' ? s.dealSalt : '',
      dealerCommits: Array.isArray(s.dealerCommits)
        ? s.dealerCommits.map(String)
        : ['', '', '', ''],
      badDeal: s.badDeal === true,
      rng: Number.isInteger(s.rng) ? s.rng! : 1,
      settings: {},
    };
  },
  sideName: (_state, seat) => SEAT_NAMES[seat] ?? `Seat ${seat + 1}`,
  rulesText: () => [
    'Four players, 13 cards each. Spades are always trumps.',
    'Each round, everyone calls how many tricks they will take (1 to 13), starting left of the dealer.',
    'Follow the suit led if you can; if you can’t, you must play a spade if you have one. The highest spade wins the trick, else the highest card of the suit led.',
    'Make your call: you score the call, plus a tenth for each extra trick. Fall short: you lose the call.',
    'Five rounds; the dealer moves round the table. Highest total wins.',
    'No clock: games with friends are played at your own pace.',
  ],
  resultDetail: (state) =>
    state.scores.map((v, s) => `${SEAT_NAMES[s]} ${(v / 10).toFixed(1)}`).join(' · '),
  stepMs: (step, pace) => {
    if (step.kind === 'leave') return pace.read;
    // A completed trick stays on the table a moment.
    const before = step.before;
    return before.trick.length === 3 ? pace.step + pace.read * 2.5 : pace.step * 1.25;
  },
  hidden: {
    seatData: bridgeSeatData,
    setupNet(seats, settings, first, net: NetSetup) {
      return {
        ...setup(seats, settings, first),
        dealerCommits: net.seatData.map((d) => toBase64(d)),
      };
    },
    isLegalNet,
    applyNet,
    personalize(state, seat, knows) {
      if (
        seat < 0 ||
        (state.phase !== 'call' && state.phase !== 'play' && state.phase !== 'reveal')
      )
        return state;
      const cards = myCards(state, seat, knows);
      if (cards.length === 0) return state;
      const byP = new Map(cards.map((c) => [c.p, c.card]));
      const hands = state.hands.map((h, s) =>
        s !== seat ? h : h.map((c) => (c.card >= 0 ? c : { ...c, card: byP.get(c.p) ?? -1 })),
      );
      return { ...state, hands };
    },
    prove(state, move, seat, knows) {
      if (!('play' in move)) return move;
      const mine = myCards(state, seat, knows).find((c) => c.p === move.play);
      return mine ? { ...move, nonce: toBase64(mine.nonce) } : move;
    },
    dealer: (state) => (state.phase === 'deal' || state.phase === 'reveal' ? state.dealer : null),
    deal(state, seat, knows, step) {
      const secret = dealerSecret(step.sha256, knows.seed!, state.round);
      if (state.phase === 'reveal') return { move: { reveal: toBase64(secret) }, hands: [] };
      const deal = dealFrom(step.sha256, secret, step.saltFor(seat), step.gameId, state.round);
      return {
        move: { deal: toBase64(deal.commitments) },
        hands: [0, 1, 2, 3]
          .filter((s) => s !== seat && !state.left[s])
          .map((s) => ({ seat: s, round: state.round, data: handData(deal, s) })),
      };
    },
  },
};
