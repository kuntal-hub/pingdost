// Turn-based games on one shared frame (Phase 43, ADR 0049 third amendment): Tic-Tac-Toe,
// Connect Four, Dots and Boxes, Snakes and Ladders and Chess. Each game is a `TurnRules`: pure
// functions over an immutable state, a computer player, and its wire form. The solo controller
// (`turn-controller.ts`), the fold for games with friends (`turn-network.ts`) and its controller
// (`turn-net-controller.ts`) work for every game.
import type {
  GameCreate,
  GameCreateSchema,
  GameMove,
  GameMoveSchema,
  GameType,
  MessageInitShape,
} from '@pingdost/protocol';

import type { Random } from './random';
import type { BotLevel } from './types';

/** The games built on this frame. */
export type TurnGameId =
  'tic-tac-toe' | 'connect-four' | 'dots-and-boxes' | 'snakes-and-ladders' | 'chess';

/** What every turn game's state has. States are plain JSON (saved, folded, compared). */
export interface TurnCore {
  /** Players, in turn order. */
  seats: number;
  /** The seat to play (meaningless once the game is over). */
  current: number;
  /** Steps so far: every move, roll and skip (a leave is not a step). */
  turns: number;
  left: boolean[];
  /** Seats in the order they left. */
  leftOrder: number[];
  /** Places once the game is over (1 = best; ties share a place), else null. */
  ranks: number[] | null;
}

/** Timings in milliseconds; the fast pace suits Motion Off (steps are still visible). */
export interface TurnPace {
  /** A move landing (a mark, a disc dropping, a line, a piece sliding). */
  step: number;
  /** The die tumbling. */
  roll: number;
  /** One square of a piece's walk. */
  hop: number;
  /** A ride up a ladder or down a snake. */
  slide: number;
  /** A computer player's pause before it plays. */
  think: number;
  /** After a step that changed nothing, so it can be read. */
  read: number;
}

export const NORMAL_TURN_PACE: TurnPace = {
  step: 360,
  roll: 800,
  hop: 170,
  slide: 520,
  think: 550,
  read: 350,
};
export const FAST_TURN_PACE: TurnPace = {
  step: 120,
  roll: 200,
  hop: 40,
  slide: 150,
  think: 300,
  read: 200,
};
/** For tests and sim players: no pauses at all. */
export const ZERO_TURN_PACE: TurnPace = { step: 0, roll: 0, hop: 0, slide: 0, think: 0, read: 0 };

export type TurnStepKind = 'move' | 'proxy' | 'roll' | 'skip' | 'leave';

/** One step as the screens animate it. */
export interface TurnStep<S, M> {
  kind: TurnStepKind;
  /** Who played (the leaver for a leave). */
  seat: number;
  before: S;
  state: S;
  move?: M;
  die?: number;
}

export type SettingsWire = MessageInitShape<typeof GameCreateSchema>['settings'];
export type PlayWire = MessageInitShape<typeof GameMoveSchema>['play'];

export interface TurnRules<S extends TurnCore, M, Settings> {
  id: TurnGameId;
  wireType: GameType;
  minPlayers: number;
  maxPlayers: number;
  /** The dice decide every move (Snakes and Ladders): a turn is a roll, there are no choices. */
  dice: boolean;
  /** Computer players come in levels (false: the dice decide, so there is nothing to choose). */
  levels: boolean;
  /**
   * Each step's timer in games with friends, or null for slow play (no timers, no skips).
   * With a timer, an absent player's turn is played for them (a proxy move, or a skip when
   * the dice need their secret), and three in a row take them out.
   */
  turnMs: number | null;
  defaultSettings: Settings;
  normalizeSettings(raw: unknown): Settings;
  settingsToWire(settings: Settings): SettingsWire;
  settingsFromWire(create: GameCreate): Settings;
  /** A new game; `first` moves first. */
  setup(seats: number, settings: Settings, first: number): S;
  /**
   * Who moves first in a game with friends, from a seat drawn from everyone's salts and the
   * host's seat (Chess: the host may pick a side). Default: the drawn seat.
   */
  firstSeat?(settings: Settings, drawn: number, host: number, seats: number): number;
  /** The current seat's moves (empty in dice games). */
  legal(state: S): M[];
  isLegal(state: S, move: M): boolean;
  apply(state: S, move: M): S;
  /** Dice games: the current seat's roll. */
  roll?(state: S, die: number): S;
  /** A missed turn: play passes to the next seat. */
  skip(state: S): S;
  leave(state: S, seat: number): S;
  bot(state: S, level: BotLevel, random: Random): M | Promise<M>;
  /**
   * Games with a timer and choices: the move played for an absent player. It must be
   * deterministic for the state and `random` (seeded from the state's hash), since every
   * client checks it.
   */
  proxy?(state: S, random: Random): M;
  moveToWire(move: M): PlayWire;
  moveFromWire(move: GameMove): M | null;
  sameMove(a: M, b: M): boolean;
  /** Every field that matters, in a fixed order: the state's hash comes from this. */
  canonical(state: S): string;
  /** A saved state read back, or null if it is not a playable state of this game. */
  restore(raw: unknown): S | null;
  /** The name of a seat's side: "X", "Red", "White". */
  sideName(state: S, seat: number): string;
  /** The rules in play, as short lines for a rules sheet. */
  rulesText(settings: Settings): string[];
  /** One more line for the result ("5 boxes to 4", "Checkmate"), or null. */
  resultDetail?(state: S): string | null;
  /** How long a step takes on screen (default: `pace.step`). */
  stepMs?(step: TurnStep<S, M>, pace: TurnPace): number;
}

/** Any turn game (method parameters are bivariant, so every game's rules fit). */
export type AnyTurnRules = TurnRules<TurnCore, unknown, unknown>;

export function isTurnGameId(id: string): id is TurnGameId {
  return (
    id === 'tic-tac-toe' ||
    id === 'connect-four' ||
    id === 'dots-and-boxes' ||
    id === 'snakes-and-ladders' ||
    id === 'chess'
  );
}

/** A fresh core for `seats` players with `first` to move. */
export function turnCore(seats: number, first: number): TurnCore {
  return {
    seats,
    current: first,
    turns: 0,
    left: Array.from({ length: seats }, () => false),
    leftOrder: [],
    ranks: null,
  };
}

/** The next seat after `from` that is still playing. */
export function nextActive(left: readonly boolean[], from: number): number {
  const n = left.length;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (!left[seat]) return seat;
  }
  return from;
}

export function activeSeats(state: TurnCore): number[] {
  return state.left.flatMap((left, seat) => (left ? [] : [seat]));
}

/**
 * Places from groups of seats that tie, best first; seats that left come after everyone, the
 * last to leave first.
 */
export function placesFrom(
  seats: number,
  groups: readonly (readonly number[])[],
  leftOrder: readonly number[],
): number[] {
  const ranks = Array.from({ length: seats }, () => seats);
  let place = 1;
  for (const group of groups) {
    for (const seat of group) ranks[seat] = place;
    place += group.length;
  }
  for (let i = leftOrder.length - 1; i >= 0; i--) ranks[leftOrder[i]!] = place++;
  return ranks;
}

/** Places by score among the players still in (higher is better, equal scores tie). */
export function placesByScore(state: TurnCore, scores: readonly number[]): number[] {
  const active = activeSeats(state).sort((a, b) => scores[b]! - scores[a]!);
  const groups: number[][] = [];
  for (const seat of active) {
    const last = groups[groups.length - 1];
    if (last && scores[last[0]!] === scores[seat]) last.push(seat);
    else groups.push([seat]);
  }
  return placesFrom(state.seats, groups, state.leftOrder);
}

/** One winner; the others still in share second place. */
export function placesWithWinner(state: TurnCore, winner: number): number[] {
  const others = activeSeats(state).filter((seat) => seat !== winner);
  return placesFrom(
    state.seats,
    others.length > 0 ? [[winner], others] : [[winner]],
    state.leftOrder,
  );
}

/** Everyone still in shares first place (a draw). */
export function placesDraw(state: TurnCore): number[] {
  return placesFrom(state.seats, [activeSeats(state)], state.leftOrder);
}

/**
 * A seat leaves. With one player left, that player wins; otherwise play goes on, passing the
 * turn if it was the leaver's. `finish` decides the places when the game ends this way.
 */
export function leaveSeat<S extends TurnCore>(
  state: S,
  seat: number,
  finish: (state: S, winner: number) => number[] = placesWithWinner,
): S {
  if (state.ranks || state.left[seat] || seat < 0 || seat >= state.seats) return state;
  const left = state.left.map((l, i) => l || i === seat);
  const next: S = { ...state, left, leftOrder: [...state.leftOrder, seat] };
  const active = activeSeats(next);
  if (active.length <= 1) return { ...next, ranks: finish(next, active[0] ?? seat) };
  if (state.current === seat) next.current = nextActive(left, seat);
  return next;
}

/** A missed turn: the next seat plays. */
export function passTurn<S extends TurnCore>(state: S): S {
  if (state.ranks) return state;
  return { ...state, current: nextActive(state.left, state.current), turns: state.turns + 1 };
}

/** The checks every saved state needs (seats, turn, the core arrays). */
export function restoreCore(raw: unknown, min: number, max: number): TurnCore | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<TurnCore>;
  const seats = s.seats;
  if (!Number.isInteger(seats) || seats! < min || seats! > max) return null;
  const n = seats!;
  const seat = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n;
  if (!seat(s.current) || !Number.isInteger(s.turns) || s.turns! < 0) return null;
  if (
    !Array.isArray(s.left) ||
    s.left.length !== n ||
    !s.left.every((v) => typeof v === 'boolean')
  ) {
    return null;
  }
  const leftOrder = Array.isArray(s.leftOrder) ? s.leftOrder.filter(seat) : [];
  let ranks: number[] | null = null;
  if (s.ranks !== null && s.ranks !== undefined) {
    if (!Array.isArray(s.ranks) || s.ranks.length !== n) return null;
    if (!s.ranks.every((r) => Number.isInteger(r) && r >= 1 && r <= n)) return null;
    ranks = [...s.ranks];
  }
  return { seats: n, current: s.current!, turns: s.turns!, left: [...s.left], leftOrder, ranks };
}

/** An integer cell array of the given length with values in [lo, hi], or null. */
export function intArray(raw: unknown, length: number, lo: number, hi: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== length) return null;
  return raw.every((v) => Number.isInteger(v) && v >= lo && v <= hi)
    ? [...(raw as number[])]
    : null;
}
