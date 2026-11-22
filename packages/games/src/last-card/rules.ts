// Last Card (Phase 45): a shedding game for 2 to 4. Match the top card's color or its number or
// symbol, or play a wild; skip, reverse and draw two act on the next player; wild draw four sets
// the color and makes the next player draw four. Call "last card" with your second-to-last card
// or draw two. First to empty their hand wins. Generic mechanics with PingDost's own name and
// cards (UNO is a trademarked game).
//
// Cards come from the 108-card mix: per color one 0 and two each of 1–9, skip, reverse and draw
// two; then four wilds and four wild draw fours. With friends every card is self-dealt from the
// owner's committed draw secrets (ADR 0052), so only its owner knows it until it is played.
import { GameType, fromBase64, toBase64 } from '@pingdost/protocol';

import { sameBytes, type Sha256 } from '../core/fair-dice';
import type { Random } from '../core/random';
import {
  activeSeats,
  leaveSeat,
  placesFrom,
  restoreCore,
  turnCore,
  type NetSetup,
  type NetStep,
  type TurnCore,
  type TurnRules,
} from '../core/turn';
import type { BotLevel } from '../core/types';

export const LAST_CARD_HAND = 7;
/** Draw secrets each seat commits to (ADR 0052). */
export const LAST_CARD_DRAWS = 128;
const COMMIT_BYTES = 16;

export const SKIP = 10;
export const REVERSE = 11;
export const DRAW_TWO = 12;
export const WILD = 13;
export const WILD_DRAW_FOUR = 14;

/** A card code: 1–52 for color × value (0–9, skip, reverse, draw two), 53 wild, 54 wild draw four. */
export function cardCode(color: number, value: number): number {
  if (value === WILD) return 53;
  if (value === WILD_DRAW_FOUR) return 54;
  return color * 13 + value + 1;
}

export interface CardFace {
  /** 0–3, or −1 for a wild. */
  color: number;
  value: number;
}

export function cardFace(code: number): CardFace {
  if (code === 53) return { color: -1, value: WILD };
  if (code === 54) return { color: -1, value: WILD_DRAW_FOUR };
  const index = code - 1;
  return { color: Math.floor(index / 13), value: index % 13 };
}

export const isWild = (code: number) => code === 53 || code === 54;

/** The card at place r (0–107) of the mix. */
export function cardFromMix(r: number): number {
  if (r >= 104) return 54;
  if (r >= 100) return 53;
  const color = Math.floor(r / 25);
  const within = r % 25;
  return cardCode(color, within === 0 ? 0 : 1 + Math.floor((within - 1) / 2));
}

/** Points a card left in a hand is worth to the winner. */
export function cardPoints(code: number): number {
  const { value } = cardFace(code);
  return value <= 9 ? value : value >= WILD ? 50 : 20;
}

export type LastCardSettings = Record<string, never>;

/** A card in a hand: the owner's draw number `k`, and the card (0 while hidden). */
export interface HandCard {
  k: number;
  card: number;
}

export interface LastCardState extends TurnCore {
  hands: HandCard[][];
  /** The card on the pile, and the color in play (a wild's chosen color). */
  top: number;
  color: number;
  direction: 1 | -1;
  /** The draw number of the card drawn this turn: it may be played, or kept with a pass. */
  drawn: number | null;
  /** Each seat's next draw number. */
  draws: number[];
  /** With friends: each seat's draw commitments (base64), and the salt behind each hidden card. */
  commits: string[];
  salts: Record<string, string>;
  /** Solo: the random state the next draw comes from. */
  rng: number;
  settings: LastCardSettings;
}

export type LastCardMove =
  | { play: number; card: number; color?: number; call?: boolean; secret?: string }
  | { draw: true; pass?: boolean }
  | { pass: true };

const encoder = new TextEncoder();
const SECRET = encoder.encode('pingdost/game/draw-secret/v1');
const COMMIT = encoder.encode('pingdost/game/draw-commit/v1');
const DRAW = encoder.encode('pingdost/game/draw/v1');
const DEAL = encoder.encode('pingdost/game/deal-salt/v1');
const START = encoder.encode('pingdost/game/start-card/v1');

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u32 = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
};

/** An unbiased place in the 108-card mix from a hash (rejecting the top of the 16-bit range). */
function mixFromHash(sha256: Sha256, hash: Uint8Array): number {
  let h = hash;
  for (;;) {
    for (let i = 0; i + 1 < h.length; i += 2) {
      const v = (h[i]! << 8) | h[i + 1]!;
      if (v < 65448) return v % 108;
    }
    h = sha256(h);
  }
}

export function drawSecret(sha256: Sha256, seed: Uint8Array, k: number): Uint8Array {
  return sha256(concat(SECRET, seed, u32(k)));
}

export function drawCommitment(sha256: Sha256, secret: Uint8Array): Uint8Array {
  return sha256(concat(COMMIT, secret)).slice(0, COMMIT_BYTES);
}

/** The card behind a draw secret, with the salt it was drawn with. */
export function drawnCard(
  sha256: Sha256,
  secret: Uint8Array,
  salt: Uint8Array,
  gameId: Uint8Array,
  seat: number,
  k: number,
): number {
  return cardFromMix(
    mixFromHash(sha256, sha256(concat(DRAW, secret, salt, gameId, u32(seat), u32(k)))),
  );
}

/** The 128 draw commitments a seat publishes at join (ADR 0052). */
export function lastCardSeatData(seed: Uint8Array, sha256: Sha256): Uint8Array {
  const out = new Uint8Array(LAST_CARD_DRAWS * COMMIT_BYTES);
  for (let k = 0; k < LAST_CARD_DRAWS; k++) {
    out.set(drawCommitment(sha256, drawSecret(sha256, seed, k)), k * COMMIT_BYTES);
  }
  return out;
}

// Solo randomness: a small generator kept in the state, so a saved game draws on the same way.
function nextRng(state: number): number {
  let x = state >>> 0 || 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

function soloDraw(rng: number): { rng: number; card: number } {
  let r = rng;
  for (;;) {
    r = nextRng(r);
    if (r < 4294967232) return { rng: r, card: cardFromMix(r % 108) };
  }
}

// Rules on the public state

export function playableOn(state: Pick<LastCardState, 'top' | 'color'>, code: number): boolean {
  if (isWild(code)) return true;
  const face = cardFace(code);
  const top = cardFace(state.top);
  return face.color === state.color || (top.value < WILD && face.value === top.value);
}

/** The seat `steps` places on in the direction of play (players who left are passed over). */
function seatAfter(state: LastCardState, from: number, steps: number): number {
  let seat = from;
  for (let i = 0; i < steps; i++) {
    for (let j = 1; j <= state.seats; j++) {
      const next = (seat + state.direction * j + state.seats * 4) % state.seats;
      if (!state.left[next]) {
        seat = next;
        break;
      }
    }
  }
  return seat;
}

/** Draws `count` cards for `seat`: known (solo) or hidden with their salt (friends). */
type Drawer = (state: LastCardState, seat: number, count: number) => LastCardState;

function soloDrawer(state: LastCardState, seat: number, count: number): LastCardState {
  let rng = state.rng;
  const hands = state.hands.map((h) => [...h]);
  const draws = [...state.draws];
  for (let i = 0; i < count; i++) {
    const drawn = soloDraw(rng);
    rng = drawn.rng;
    hands[seat]!.push({ k: draws[seat]!, card: drawn.card });
    draws[seat]! += 1;
  }
  return { ...state, hands, draws, rng };
}

function netDrawer(step: NetStep): Drawer {
  return (state, seat, count) => {
    const hands = state.hands.map((h) => [...h]);
    const draws = [...state.draws];
    const salts = { ...state.salts };
    const salt = toBase64(step.saltFor(seat));
    for (let i = 0; i < count; i++) {
      const k = draws[seat]!;
      if (k >= LAST_CARD_DRAWS) break; // out of committed draws: no more cards
      hands[seat]!.push({ k, card: 0 });
      salts[`${seat}:${k}`] = salt;
      draws[seat]! += 1;
    }
    return { ...state, hands, draws, salts };
  };
}

function finish(state: LastCardState, winner: number): number[] {
  const others = activeSeats(state)
    .filter((s) => s !== winner)
    .sort((a, b) => state.hands[a]!.length - state.hands[b]!.length);
  const groups: number[][] = [[winner]];
  for (const seat of others) {
    const last = groups[groups.length - 1]!;
    if (last[0] !== winner && state.hands[last[0]!]!.length === state.hands[seat]!.length) {
      last.push(seat);
    } else {
      groups.push([seat]);
    }
  }
  return placesFrom(state.seats, groups, state.leftOrder);
}

function structurallyOk(state: LastCardState, move: LastCardMove): boolean {
  if (state.ranks) return false;
  if ('play' in move) {
    if (!Number.isInteger(move.card) || move.card < 1 || move.card > 54) return false;
    if (
      isWild(move.card) &&
      !(Number.isInteger(move.color) && move.color! >= 0 && move.color! <= 3)
    ) {
      return false;
    }
    if (state.drawn !== null && move.play !== state.drawn) return false;
    if (!state.hands[state.current]!.some((c) => c.k === move.play)) return false;
    return playableOn(state, move.card);
  }
  if ('draw' in move) return state.drawn === null;
  return state.drawn !== null;
}

/** Applies a move whose card (if any) is already checked. */
function applyWith(state: LastCardState, move: LastCardMove, drawer: Drawer): LastCardState {
  const seat = state.current;
  let next: LastCardState = { ...state, turns: state.turns + 1 };
  if ('draw' in move) {
    next = drawer(next, seat, 1);
    const k = next.draws[seat]! - 1;
    if (move.pass || next.draws[seat] === state.draws[seat]) {
      return { ...next, drawn: null, current: seatAfter(next, seat, 1) };
    }
    return { ...next, drawn: k };
  }
  if ('pass' in move) return { ...next, drawn: null, current: seatAfter(next, seat, 1) };

  const hands = next.hands.map((h, i) => (i === seat ? h.filter((c) => c.k !== move.play) : h));
  const face = cardFace(move.card);
  next = {
    ...next,
    hands,
    top: move.card,
    color: isWild(move.card) ? move.color! : face.color,
    drawn: null,
  };
  const salts = { ...next.salts };
  delete salts[`${seat}:${move.play}`];
  next.salts = salts;
  if (hands[seat]!.length === 0) return { ...next, ranks: finish(next, seat) };
  if (hands[seat]!.length === 1 && !move.call) next = drawer(next, seat, 2);
  const players = activeSeats(next).length;
  switch (face.value) {
    case SKIP:
      return { ...next, current: seatAfter(next, seat, 2) };
    case REVERSE: {
      const reversed: LastCardState = { ...next, direction: next.direction === 1 ? -1 : 1 };
      return { ...reversed, current: seatAfter(reversed, seat, players === 2 ? 2 : 1) };
    }
    case DRAW_TWO: {
      const victim = seatAfter(next, seat, 1);
      const drawn = drawer(next, victim, 2);
      return { ...drawn, current: seatAfter(drawn, seat, 2) };
    }
    case WILD_DRAW_FOUR: {
      const victim = seatAfter(next, seat, 1);
      const drawn = drawer(next, victim, 4);
      return { ...drawn, current: seatAfter(drawn, seat, 2) };
    }
    default:
      return { ...next, current: seatAfter(next, seat, 1) };
  }
}

function emptyState(seats: number, settings: LastCardSettings, first: number): LastCardState {
  return {
    ...turnCore(seats, first),
    hands: Array.from({ length: seats }, () => []),
    top: cardCode(0, 0),
    color: 0,
    direction: 1,
    drawn: null,
    draws: Array.from({ length: seats }, () => 0),
    commits: Array.from({ length: seats }, () => ''),
    salts: {},
    rng: 0,
    settings,
  };
}

/** Moves for the current seat, from a state where its cards are known. */
function legal(state: LastCardState): LastCardMove[] {
  if (state.ranks) return [];
  const hand = state.hands[state.current]!;
  const call = hand.length === 2;
  const plays: LastCardMove[] = [];
  for (const c of hand) {
    if (c.card === 0) continue;
    if (state.drawn !== null && c.k !== state.drawn) continue;
    if (!playableOn(state, c.card)) continue;
    if (isWild(c.card)) {
      for (let color = 0; color < 4; color++) plays.push({ play: c.k, card: c.card, color, call });
    } else {
      plays.push({ play: c.k, card: c.card, call });
    }
  }
  return [...plays, state.drawn === null ? { draw: true } : { pass: true }];
}

function isLegal(state: LastCardState, move: LastCardMove): boolean {
  if (!structurallyOk(state, move)) return false;
  if ('play' in move) {
    return state.hands[state.current]!.find((c) => c.k === move.play)?.card === move.card;
  }
  return true;
}

// Computer players: they look only at their own hand, the pile and how many cards others hold.

function nextSeat(state: LastCardState): number {
  return seatAfter(state, state.current, 1);
}

function favoriteColor(hand: readonly HandCard[], except?: number): number {
  const counts = [0, 0, 0, 0];
  for (const c of hand) {
    if (c.k === except || c.card === 0) continue;
    const { color } = cardFace(c.card);
    if (color >= 0) counts[color]! += 1;
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (counts[i]! > counts[best]!) best = i;
  return best;
}

export function chooseLastCardMove(
  state: LastCardState,
  level: BotLevel,
  random: Random,
): LastCardMove {
  const options = legal(state);
  const plays = options.filter((m): m is Extract<LastCardMove, { play: number }> => 'play' in m);
  const other = options.find((m) => !('play' in m))!;
  if (plays.length === 0) return other;
  const hand = state.hands[state.current]!;
  const forget = level === 'easy' && random.next() < 0.3;
  const withCall = (m: Extract<LastCardMove, { play: number }>) => ({
    ...m,
    call: !forget && hand.length === 2,
  });

  if (level === 'easy') {
    if (state.drawn === null && random.next() < 0.25) return other;
    return withCall(plays[random.int(plays.length)]!);
  }
  const danger = state.hands[nextSeat(state)]!.length;
  const score = (m: Extract<LastCardMove, { play: number }>) => {
    const { value } = cardFace(m.card);
    let s = 0;
    if (isWild(m.card)) {
      // Keep wilds for later, unless the next player is close to winning.
      s -= 30;
      if (value === WILD_DRAW_FOUR && danger <= (level === 'hard' ? 2 : 1)) s += 80;
      if (m.color !== favoriteColor(hand, m.play)) s -= 20;
    } else if (value === SKIP || value === DRAW_TWO || value === REVERSE) {
      s += danger <= (level === 'hard' ? 3 : 2) ? 40 : 5;
      if (value === DRAW_TWO) s += 3;
    } else {
      s += value;
    }
    if (level === 'hard' && !isWild(m.card)) {
      // Stay in the color you hold most of.
      s += cardFace(m.card).color === favoriteColor(hand, m.play) ? 8 : 0;
    }
    return s;
  };
  let best = -Infinity;
  let top: Extract<LastCardMove, { play: number }>[] = [];
  for (const m of plays) {
    const s = score(m);
    if (s > best) {
      best = s;
      top = [m];
    } else if (s === best) {
      top.push(m);
    }
  }
  return withCall(top[random.int(top.length)]!);
}

// Hidden hands (ADR 0052)

const SEAT_COLOR_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];
const COLOR_WORDS = ['red', 'yellow', 'green', 'blue'];

/** The four card colors, in code order (ui-tokens `gameBoardColors().players`). */
export const LAST_CARD_COLORS = ['red', 'yellow', 'green', 'blue'] as const;

export function cardName(code: number): string {
  const { color, value } = cardFace(code);
  if (value === WILD) return 'wild';
  if (value === WILD_DRAW_FOUR) return 'wild draw four';
  const word =
    value === SKIP
      ? 'skip'
      : value === REVERSE
        ? 'reverse'
        : value === DRAW_TWO
          ? 'draw two'
          : String(value);
  return `${COLOR_WORDS[color]} ${word}`;
}

function commitmentAt(state: LastCardState, seat: number, k: number): Uint8Array | null {
  const all = state.commits[seat];
  if (!all) return null;
  const bytes = fromBase64(all);
  if ((k + 1) * COMMIT_BYTES > bytes.length) return null;
  return bytes.slice(k * COMMIT_BYTES, (k + 1) * COMMIT_BYTES);
}

/** Whether a revealed secret is the seat's draw k and gives the claimed card. */
function provesCard(
  state: LastCardState,
  seat: number,
  move: Extract<LastCardMove, { play: number }>,
  sha256: Sha256,
  gameId: Uint8Array,
): boolean {
  if (!move.secret) return false;
  const secret = fromBase64(move.secret);
  const commitment = commitmentAt(state, seat, move.play);
  const salt = state.salts[`${seat}:${move.play}`];
  if (!commitment || !salt) return false;
  if (!sameBytes(drawCommitment(sha256, secret), commitment)) return false;
  return drawnCard(sha256, secret, fromBase64(salt), gameId, seat, move.play) === move.card;
}

function setupNet(
  seats: number,
  settings: LastCardSettings,
  first: number,
  net: NetSetup,
): LastCardState {
  let state = emptyState(seats, settings, first);
  state = { ...state, commits: net.seatData.map((d) => toBase64(d)) };
  for (let seat = 0; seat < seats; seat++) {
    // A salt the seat did not choose: the others' salts, and the host's start salt unless the
    // seat is the host (ADR 0052).
    const others = net.salts.filter((_, i) => i !== seat);
    const salt = net.sha256(
      concat(DEAL, ...others, ...(seat === net.host ? [] : [net.startSalt]), u32(seat)),
    );
    state = netDrawer({ sha256: net.sha256, gameId: net.gameId, saltFor: () => salt })(
      state,
      seat,
      LAST_CARD_HAND,
    );
  }
  // The first card on the pile: public, drawn until it is a number card.
  let hash = net.sha256(concat(START, net.gameId, ...net.salts, net.startSalt));
  for (;;) {
    const card = cardFromMix(mixFromHash(net.sha256, hash));
    if (cardFace(card).value <= 9) return { ...state, top: card, color: cardFace(card).color };
    hash = net.sha256(hash);
  }
}

export const LAST_CARD: TurnRules<LastCardState, LastCardMove, LastCardSettings> = {
  id: 'last-card',
  wireType: GameType.LAST_CARD,
  minPlayers: 2,
  maxPlayers: 4,
  dice: false,
  levels: true,
  turnMs: 30_000,
  defaultSettings: {},
  normalizeSettings: () => ({}),
  settingsToWire: () => ({ case: 'lastCard', value: {} }),
  settingsFromWire: () => ({}),
  setup: emptyState,
  soloSetup(state, random) {
    let next: LastCardState = { ...state, rng: random.int(0x7fffffff) + 1 };
    for (let seat = 0; seat < state.seats; seat++) next = soloDrawer(next, seat, LAST_CARD_HAND);
    let rng = next.rng;
    for (;;) {
      const drawn = soloDraw(rng);
      rng = drawn.rng;
      if (cardFace(drawn.card).value <= 9) {
        return { ...next, rng, top: drawn.card, color: cardFace(drawn.card).color };
      }
    }
  },
  legal,
  isLegal,
  apply: (state, move) => (isLegal(state, move) ? applyWith(state, move, soloDrawer) : state),
  skip: (state) => ({
    ...state,
    drawn: null,
    current: seatAfter(state, state.current, 1),
    turns: state.turns + 1,
  }),
  leave: (state, seat) => {
    const next = leaveSeat(state, seat, finish);
    return next.current !== state.current ? { ...next, drawn: null } : next;
  },
  bot: chooseLastCardMove,
  proxy: (state) => (state.drawn === null ? { draw: true, pass: true } : { pass: true }),
  moveToWire: (move) => ({
    case: 'lastCard',
    value:
      'play' in move
        ? {
            drawIndex: move.play,
            card: move.card,
            color: isWild(move.card) ? (move.color ?? 0) + 1 : 0,
            lastCardCall: move.call ?? false,
            secret: move.secret ? fromBase64(move.secret) : new Uint8Array(0),
          }
        : 'draw' in move
          ? { draw: true, pass: move.pass ?? false }
          : { pass: true },
  }),
  moveFromWire: (wire) => {
    if (wire.play.case !== 'lastCard') return null;
    const v = wire.play.value;
    if (v.draw) return v.pass ? { draw: true, pass: true } : { draw: true };
    if (v.pass) return { pass: true };
    if (v.card === 0) return null;
    return {
      play: v.drawIndex,
      card: v.card,
      ...(v.color > 0 ? { color: v.color - 1 } : {}),
      ...(v.lastCardCall ? { call: true } : {}),
      ...(v.secret.length > 0 ? { secret: toBase64(v.secret) } : {}),
    };
  },
  sameMove: (a, b) => {
    if ('play' in a && 'play' in b)
      return a.play === b.play && a.card === b.card && (a.color ?? -1) === (b.color ?? -1);
    if ('draw' in a && 'draw' in b) return (a.pass ?? false) === (b.pass ?? false);
    return 'pass' in a && 'pass' in b && !('draw' in a) && !('draw' in b);
  },
  canonical: (s) =>
    [
      s.current,
      s.turns,
      s.direction,
      s.top,
      s.color,
      s.drawn ?? '-',
      s.hands.map((h) => h.map((c) => `${c.k}.${c.card}`).join(',')).join(';'),
      s.draws.join(','),
      Object.keys(s.salts)
        .sort()
        .map((key) => `${key}=${s.salts[key]}`)
        .join(','),
      s.left.map(Number).join(''),
      s.ranks?.join(',') ?? '-',
    ].join('|'),
  restore(raw) {
    const core = restoreCore(raw, 2, 4);
    if (!core) return null;
    const s = raw as Partial<LastCardState>;
    const card = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 54;
    if (!Array.isArray(s.hands) || s.hands.length !== core.seats) return null;
    const hands: HandCard[][] = [];
    for (const hand of s.hands) {
      if (!Array.isArray(hand)) return null;
      const cards = (hand as unknown[]).flatMap((c) => {
        const v = c as Partial<HandCard>;
        return Number.isInteger(v.k) && card(v.card) ? [{ k: v.k!, card: v.card! }] : [];
      });
      if (cards.length !== hand.length) return null;
      hands.push(cards);
    }
    if (!card(s.top) || s.top === 0 || !Number.isInteger(s.color) || s.color! < 0 || s.color! > 3)
      return null;
    if (!Array.isArray(s.draws) || s.draws.length !== core.seats) return null;
    return {
      ...core,
      hands,
      top: s.top!,
      color: s.color!,
      direction: s.direction === -1 ? -1 : 1,
      drawn: Number.isInteger(s.drawn) ? s.drawn! : null,
      draws: s.draws.map((d) => (Number.isInteger(d) ? d : 0)),
      commits: Array.isArray(s.commits) ? s.commits.map(String) : [],
      salts: typeof s.salts === 'object' && s.salts !== null ? { ...s.salts } : {},
      rng: Number.isInteger(s.rng) ? s.rng! : 1,
      settings: {},
    };
  },
  sideName: (_state, seat) => SEAT_COLOR_NAMES[seat] ?? `Player ${seat + 1}`,
  rulesText: () => [
    'Match the card on the pile by color, or by number or symbol. A wild goes on anything and picks the next color.',
    'Skip: the next player misses a turn. Reverse: play changes direction (with two players it is a skip). Draw two: the next player draws two and misses a turn. Wild draw four: pick the color; the next player draws four and misses a turn.',
    "Can't or don't want to play? Draw one card: you may play it at once, or keep it and pass.",
    'Tap "Last card!" before playing your second-to-last card, or you draw two.',
    'First to play their last card wins; the others are placed by how few cards they hold.',
    'Cards are drawn from the full mix every time (it never runs out), so a hand can hold cards that a single pack would not.',
  ],
  resultDetail: (state) => {
    if (!state.ranks) return null;
    const winner = state.ranks.findIndex((r, seat) => r === 1 && !state.left[seat]);
    const losers = activeSeats(state).filter((s) => s !== winner);
    const known = losers.every((s) => state.hands[s]!.every((c) => c.card !== 0));
    if (known && winner >= 0) {
      const points = losers.reduce(
        (sum, s) => sum + state.hands[s]!.reduce((p, c) => p + cardPoints(c.card), 0),
        0,
      );
      return `${points} points from the cards left`;
    }
    return (
      losers.map((s) => `${SEAT_COLOR_NAMES[s]} ${state.hands[s]!.length} left`).join(' · ') || null
    );
  },
  stepMs: (step, pace) => (step.kind === 'leave' ? pace.read : pace.step + 120),
  hidden: {
    seatData: lastCardSeatData,
    setupNet,
    isLegalNet: (state, move, step) => {
      if (!structurallyOk(state, move)) return false;
      if ('play' in move) return provesCard(state, state.current, move, step.sha256, step.gameId);
      return true;
    },
    applyNet: (state, move, step) => applyWith(state, move, netDrawer(step)),
    personalize(state, seat, knows) {
      if (!knows.seed || seat < 0) return state;
      const hands = state.hands.map((hand, s) =>
        s !== seat
          ? hand
          : hand.map((c) => {
              if (c.card !== 0) return c;
              const salt = state.salts[`${seat}:${c.k}`];
              if (!salt) return c;
              const secret = drawSecret(knows.sha256, knows.seed!, c.k);
              return {
                ...c,
                card: drawnCard(knows.sha256, secret, fromBase64(salt), knows.gameId, seat, c.k),
              };
            }),
      );
      return { ...state, hands };
    },
    prove(_state, move, _seat, knows) {
      if (!('play' in move) || !knows.seed) return move;
      return { ...move, secret: toBase64(drawSecret(knows.sha256, knows.seed, move.play)) };
    },
  },
};
