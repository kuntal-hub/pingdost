// Ludo rules (ADR 0049): Ludo King-style classic by default, with the host's toggles. Pure
// functions over plain data, so every device folds the same moves into the same state.
import {
  HOME,
  LAST_TRACK,
  LUDO_COLORS,
  SAFE_INDEXES,
  trackIndex,
  YARD,
  type LudoColor,
} from './board';

/** Every player always has four pieces (the user's rule, ADR 0050). */
export const LUDO_TOKENS = 4;

export interface LudoSettings {
  /** A piece leaves the yard only on a 6. Off: on any roll. */
  needSix: boolean;
  /** Two pieces of one color on a plain square form a wall others cannot pass or land on. */
  blockades: boolean;
  /** The game ends when the first player is home. Off: the rest play on for places. */
  stopAtFirstWinner: boolean;
}

export const DEFAULT_LUDO_SETTINGS: LudoSettings = {
  needSix: true,
  blockades: false,
  stopAtFirstWinner: false,
};

/** Settings from storage or the wire; anything unknown falls back to the default. */
export function normalizeLudoSettings(raw: unknown): LudoSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const flag = (key: 'needSix' | 'blockades' | 'stopAtFirstWinner'): boolean => {
    const stored = value[key];
    return typeof stored === 'boolean' ? stored : DEFAULT_LUDO_SETTINGS[key];
  };
  return {
    needSix: flag('needSix'),
    blockades: flag('blockades'),
    stopAtFirstWinner: flag('stopAtFirstWinner'),
  };
}

export interface LudoPlayer {
  color: LudoColor;
  /** Each piece's progress (see `board.ts`). */
  tokens: number[];
  /** Finishing place, 1-based; null while playing. */
  rank: number | null;
  /** Left a game with friends: skipped, pieces off the board. */
  left: boolean;
}

export type LudoPhase = 'roll' | 'move' | 'over';

export interface LudoState {
  settings: LudoSettings;
  /** In turn order: clockwise by color. A *seat* is an index into this list. */
  players: LudoPlayer[];
  /** Whose turn it is. */
  current: number;
  phase: LudoPhase;
  /** The roll waiting for a move (`move`), else the last roll, for display. */
  die: number | null;
  /** Sixes in a row this turn. */
  sixes: number;
  /** Finished turns: the wire's turn sequence number (Phase 42). */
  turns: number;
}

export interface Capture {
  seat: number;
  token: number;
  /** Where the captured piece was. */
  from: number;
}

export interface MoveResult {
  state: LudoState;
  seat: number;
  token: number;
  from: number;
  to: number;
  captures: Capture[];
  /** The piece reached home. */
  home: boolean;
  /** The mover rolls again. */
  again: boolean;
}

export type RollOutcome =
  /** The roller picks a piece. */
  | 'move'
  /** No piece can move: the turn passed. */
  | 'pass'
  /** A third 6 in a row: the turn passed without moving. */
  | 'third-six';

export interface RollResult {
  state: LudoState;
  seat: number;
  die: number;
  outcome: RollOutcome;
}

export class LudoRuleError extends Error {}

/**
 * A new game. `colors` are the players' colors (2–4, any order; play goes clockwise);
 * `first` is the color that rolls first.
 */
export function setupLudo(
  colors: readonly LudoColor[],
  settings: LudoSettings = DEFAULT_LUDO_SETTINGS,
  first: LudoColor = colors[0]!,
): LudoState {
  if (colors.length < 2 || colors.length > 4 || new Set(colors).size !== colors.length) {
    throw new LudoRuleError('Ludo needs 2 to 4 different colors');
  }
  const ordered = LUDO_COLORS.filter((color) => colors.includes(color));
  const current = ordered.indexOf(first);
  if (current < 0) throw new LudoRuleError('the first player must be in the game');
  return {
    settings,
    players: ordered.map((color) => ({
      color,
      tokens: Array.from({ length: LUDO_TOKENS }, () => YARD),
      rank: null,
      left: false,
    })),
    current,
    phase: 'roll',
    die: null,
    sixes: 0,
    turns: 0,
  };
}

/** The colors a game of `count` players uses, `you` included: opposite corners for two. */
export function colorsFor(count: number, you: LudoColor): LudoColor[] {
  const start = LUDO_COLORS.indexOf(you);
  const at = (offset: number): LudoColor => LUDO_COLORS[(start + offset) % 4]!;
  if (count === 2) return [you, at(2)];
  if (count === 3) return [you, at(1), at(2)];
  return [you, at(1), at(2), at(3)];
}

export function seatOf(state: LudoState, color: LudoColor): number {
  return state.players.findIndex((player) => player.color === color);
}

/** Still playing: not finished and not left. */
export function isActive(player: LudoPlayer): boolean {
  return player.rank === null && !player.left;
}

/** Rolls for the player whose turn it is. */
export function roll(state: LudoState, die: number): RollResult {
  if (state.phase !== 'roll') throw new LudoRuleError('not time to roll');
  if (!Number.isInteger(die) || die < 1 || die > 6) throw new LudoRuleError('bad die');
  const seat = state.current;
  const sixes = die === 6 ? state.sixes + 1 : 0;
  if (sixes === 3) return { state: endTurn({ ...state, die }), seat, die, outcome: 'third-six' };
  const rolled: LudoState = { ...state, die, sixes, phase: 'move' };
  if (legalTokens(rolled).length === 0) {
    return { state: endTurn(rolled), seat, die, outcome: 'pass' };
  }
  return { state: rolled, seat, die, outcome: 'move' };
}

/** The pieces the current player may move with the rolled die. */
export function legalTokens(state: LudoState): number[] {
  if (state.phase !== 'move' || state.die === null) return [];
  const player = state.players[state.current]!;
  const legal: number[] = [];
  for (let token = 0; token < player.tokens.length; token++) {
    if (targetOf(state, state.current, token, state.die) !== null) legal.push(token);
  }
  return legal;
}

/**
 * Legal pieces with a different outcome each (two pieces in the yard move alike): one entry
 * means there is nothing to choose, so the app may move it by itself.
 */
export function distinctTokens(state: LudoState): number[] {
  const player = state.players[state.current];
  if (!player) return [];
  const seen = new Set<number>();
  return legalTokens(state).filter((token) => {
    const progress = player.tokens[token]!;
    if (seen.has(progress)) return false;
    seen.add(progress);
    return true;
  });
}

/** Where piece `token` of `seat` would land with `die`, or null if it cannot move. */
export function targetOf(
  state: LudoState,
  seat: number,
  token: number,
  die: number,
): number | null {
  const player = state.players[seat]!;
  const from = player.tokens[token];
  if (from === undefined || from >= HOME) return null;
  if (from === YARD) {
    if (state.settings.needSix && die !== 6) return null;
    return blocked(state, seat, 0, 0) ? null : 0;
  }
  const to = from + die;
  if (to > HOME) return null;
  if (state.settings.blockades && blocked(state, seat, from + 1, Math.min(to, LAST_TRACK))) {
    return null;
  }
  return to;
}

/** Moves piece `token` of the current player by the rolled die. */
export function move(state: LudoState, token: number): MoveResult {
  if (state.phase !== 'move' || state.die === null) throw new LudoRuleError('not time to move');
  const seat = state.current;
  const die = state.die;
  const to = targetOf(state, seat, token, die);
  if (to === null) throw new LudoRuleError('that piece cannot move');
  const players = state.players.map((player) => ({ ...player, tokens: [...player.tokens] }));
  const mover = players[seat]!;
  const from = mover.tokens[token]!;
  mover.tokens[token] = to;

  const captures: Capture[] = [];
  const index = trackIndex(mover.color, to);
  if (index !== null && !SAFE_INDEXES.has(index)) {
    players.forEach((other, otherSeat) => {
      if (otherSeat === seat || other.left) return;
      other.tokens.forEach((progress, otherToken) => {
        if (trackIndex(other.color, progress) === index) {
          captures.push({ seat: otherSeat, token: otherToken, from: progress });
          other.tokens[otherToken] = YARD;
        }
      });
    });
  }

  const home = to === HOME;
  let next: LudoState = { ...state, players, phase: 'roll' };
  if (home && mover.tokens.every((progress) => progress === HOME)) {
    mover.rank = players.filter((player) => player.rank !== null).length + 1;
    next = finishIfOver(next);
    if (next.phase === 'over')
      return { state: next, seat, token, from, to, captures, home, again: false };
    return { state: endTurn(next), seat, token, from, to, captures, home, again: false };
  }
  const again = die === 6 || captures.length > 0 || home;
  if (again) return { state: next, seat, token, from, to, captures, home, again };
  return { state: endTurn(next), seat, token, from, to, captures, home, again };
}

/** A player leaves (a game with friends): pieces leave the board; play skips them. */
export function leave(state: LudoState, seat: number): LudoState {
  const player = state.players[seat];
  if (!player || !isActive(player) || state.phase === 'over') return state;
  const players = state.players.map((p, i) =>
    i === seat ? { ...p, left: true, tokens: p.tokens.map(() => YARD) } : p,
  );
  const next = finishIfOver({ ...state, players });
  if (next.phase === 'over') return next;
  return seat === state.current ? endTurn(next) : next;
}

/** Final places, best first (left players last, in seat order). */
export function standings(
  state: LudoState,
): { seat: number; color: LudoColor; rank: number | null; left: boolean }[] {
  return state.players
    .map((player, seat) => ({ seat, color: player.color, rank: player.rank, left: player.left }))
    .sort(
      (a, b) =>
        (a.rank ?? 99) - (b.rank ?? 99) || Number(a.left) - Number(b.left) || a.seat - b.seat,
    );
}

/** How far a player has come in total: for the computer players and tie-breaks. */
export function totalProgress(player: LudoPlayer): number {
  return player.tokens.reduce((sum, progress) => sum + progress + 1, 0);
}

// The turn passes to the next player still playing.
function endTurn(state: LudoState): LudoState {
  const count = state.players.length;
  let current = state.current;
  for (let i = 1; i <= count; i++) {
    const candidate = (state.current + i) % count;
    if (isActive(state.players[candidate]!)) {
      current = candidate;
      break;
    }
  }
  return { ...state, current, phase: 'roll', sixes: 0, turns: state.turns + 1 };
}

// Over when at most one player is still playing, or at the first winner if so set. The rest
// are ranked by how far they came.
function finishIfOver(state: LudoState): LudoState {
  const active = state.players.filter(isActive);
  const someoneFinished = state.players.some((player) => player.rank !== null);
  if (active.length > 1 && !(state.settings.stopAtFirstWinner && someoneFinished)) return state;
  let rank = state.players.filter((player) => player.rank !== null).length;
  const order = state.players
    .map((player, seat) => ({ player, seat }))
    .filter(({ player }) => isActive(player))
    .sort((a, b) => totalProgress(b.player) - totalProgress(a.player) || a.seat - b.seat);
  const players = state.players.map((player) => ({ ...player }));
  for (const { seat } of order) players[seat]!.rank = ++rank;
  return { ...state, players, phase: 'over' };
}

// With blockades on: is a square from `fromProgress` to `toProgress` (the mover's progress,
// track part only) walled by another color? A wall needs two pieces on a plain square.
// Without blockades nothing blocks.
function blocked(
  state: LudoState,
  seat: number,
  fromProgress: number,
  toProgress: number,
): boolean {
  if (!state.settings.blockades) return false;
  const mover = state.players[seat]!;
  for (let progress = fromProgress; progress <= toProgress; progress++) {
    const index = trackIndex(mover.color, progress);
    if (index === null || SAFE_INDEXES.has(index)) continue;
    for (const [otherSeat, other] of state.players.entries()) {
      if (otherSeat === seat || other.left) continue;
      const here = other.tokens.filter((p) => trackIndex(other.color, p) === index).length;
      if (here >= 2) return true;
    }
  }
  return false;
}
