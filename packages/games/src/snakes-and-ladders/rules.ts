// Snakes and Ladders (Phase 43): 2 to 4 players race from off the board to square 100; a
// ladder's foot lifts you to its top, a snake's head drops you to its tail. The dice decide
// everything, so computer players only roll (no levels). With friends the dice are fair dice
// (`fair-dice.ts`). The board's layout is PingDost's own.
import { GameType } from '@pingdost/protocol';

import {
  intArray,
  leaveSeat,
  nextActive,
  passTurn,
  placesFrom,
  restoreCore,
  turnCore,
  type TurnCore,
  type TurnRules,
} from '../core/turn';

export const SNAKES_FINISH = 100;

/** [bottom, top] */
export const LADDERS: readonly (readonly [number, number])[] = [
  [3, 22],
  [8, 30],
  [20, 41],
  [28, 55],
  [51, 72],
  [63, 81],
  [71, 89],
  [80, 99],
];

/** [head, tail] */
export const SNAKES: readonly (readonly [number, number])[] = [
  [17, 6],
  [32, 10],
  [48, 26],
  [62, 18],
  [75, 45],
  [88, 52],
  [95, 74],
  [97, 78],
];

const JUMPS = new Map<number, number>([...LADDERS, ...SNAKES].map(([from, to]) => [from, to]));

export interface SnakesSettings {
  /** A 6 gives another roll (at most two extra in a row). */
  sixRollsAgain: boolean;
  /** A roll past 100 bounces back; otherwise the piece stays. */
  bounceBack: boolean;
}

export interface SnakesState extends TurnCore {
  /** Each seat's square: 0 before the first square, then 1–100. */
  positions: number[];
  /** Extra rolls in a row from sixes. */
  sixes: number;
  settings: SnakesSettings;
}

export type SnakesMove = never;

/** Seat colors, in seat order (the four game colors). */
export const SNAKES_COLORS = ['red', 'blue', 'green', 'yellow'] as const;
export const SNAKES_COLOR_NAMES = ['Red', 'Blue', 'Green', 'Yellow'] as const;

export const DEFAULT_SNAKES_SETTINGS: SnakesSettings = { sixRollsAgain: false, bounceBack: false };

export function normalizeSnakesSettings(raw: unknown): SnakesSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    sixRollsAgain: value.sixRollsAgain === true,
    bounceBack: value.bounceBack === true,
  };
}

/** How a roll moves a piece: the squares walked (in order) and the ladder or snake after. */
export interface SnakesPath {
  walk: number[];
  jump: { from: number; to: number; kind: 'ladder' | 'snake' } | null;
  end: number;
}

export function snakesPath(from: number, die: number, settings: SnakesSettings): SnakesPath {
  const walk: number[] = [];
  let at = from;
  let target = from + die;
  if (target > SNAKES_FINISH) {
    if (!settings.bounceBack) return { walk: [], jump: null, end: from };
    target = SNAKES_FINISH - (target - SNAKES_FINISH);
  }
  for (let i = 0; i < die; i++) {
    // Up to 100, then back down when bouncing.
    const forward = from + i + 1 <= SNAKES_FINISH;
    at = forward ? at + 1 : at - 1;
    walk.push(at);
  }
  const to = JUMPS.get(target);
  if (to === undefined) return { walk, jump: null, end: target };
  return { walk, jump: { from: target, to, kind: to > target ? 'ladder' : 'snake' }, end: to };
}

/**
 * Where a square sits on the board: row 0 at the top, column 0 on the left. Square 1 is bottom
 * left, and the rows run back and forth up to 100 at the top left.
 */
export function snakesSquareAt(square: number): { row: number; col: number } {
  const index = Math.max(1, Math.min(SNAKES_FINISH, square)) - 1;
  const fromBottom = Math.floor(index / 10);
  const col = fromBottom % 2 === 0 ? index % 10 : 9 - (index % 10);
  return { row: 9 - fromBottom, col };
}

function setup(seats: number, settings: SnakesSettings, first: number): SnakesState {
  return {
    ...turnCore(seats, first),
    positions: Array.from({ length: seats }, () => 0),
    sixes: 0,
    settings,
  };
}

function finish(state: SnakesState, winner: number): number[] {
  const others = state.left
    .flatMap((left, seat) => (left || seat === winner ? [] : [seat]))
    .sort((a, b) => state.positions[b]! - state.positions[a]!);
  const groups: number[][] = [[winner]];
  for (const seat of others) {
    const last = groups[groups.length - 1]!;
    if (last[0] !== winner && state.positions[last[0]!] === state.positions[seat]) last.push(seat);
    else groups.push([seat]);
  }
  return placesFrom(state.seats, groups, state.leftOrder);
}

function roll(state: SnakesState, die: number): SnakesState {
  if (state.ranks || !Number.isInteger(die) || die < 1 || die > 6) return state;
  const seat = state.current;
  const path = snakesPath(state.positions[seat]!, die, state.settings);
  const positions = [...state.positions];
  positions[seat] = path.end;
  const next: SnakesState = { ...state, positions, turns: state.turns + 1 };
  if (path.end === SNAKES_FINISH) return { ...next, sixes: 0, ranks: finish(next, seat) };
  if (die === 6 && state.settings.sixRollsAgain && state.sixes < 2) {
    return { ...next, sixes: state.sixes + 1 };
  }
  return { ...next, sixes: 0, current: nextActive(state.left, seat) };
}

export const SNAKES_AND_LADDERS: TurnRules<SnakesState, SnakesMove, SnakesSettings> = {
  id: 'snakes-and-ladders',
  wireType: GameType.SNAKES_AND_LADDERS,
  minPlayers: 2,
  maxPlayers: 4,
  dice: true,
  levels: false,
  turnMs: 30_000,
  defaultSettings: DEFAULT_SNAKES_SETTINGS,
  normalizeSettings: normalizeSnakesSettings,
  settingsToWire: (settings) => ({ case: 'snakes', value: { ...settings } }),
  settingsFromWire: (create) =>
    create.settings.case === 'snakes'
      ? normalizeSnakesSettings({
          sixRollsAgain: create.settings.value.sixRollsAgain,
          bounceBack: create.settings.value.bounceBack,
        })
      : DEFAULT_SNAKES_SETTINGS,
  setup,
  legal: () => [],
  isLegal: () => false,
  apply: (state) => state,
  roll,
  skip: (state) => ({ ...passTurn(state), sixes: 0 }),
  leave: (state, seat) => ({ ...leaveSeat(state, seat, finish), sixes: 0 }),
  bot: () => {
    throw new Error('Snakes and Ladders has no moves to choose');
  },
  moveToWire: () => ({ case: undefined }),
  moveFromWire: () => null,
  sameMove: () => false,
  canonical: (s) =>
    [
      s.current,
      s.turns,
      s.sixes,
      s.positions.join(','),
      s.left.map(Number).join(''),
      s.ranks?.join(',') ?? '-',
      s.settings.sixRollsAgain ? 1 : 0,
      s.settings.bounceBack ? 1 : 0,
    ].join('|'),
  restore(raw) {
    const core = restoreCore(raw, 2, 4);
    if (!core) return null;
    const s = raw as Partial<SnakesState>;
    const positions = intArray(s.positions, core.seats, 0, SNAKES_FINISH);
    const sixes = Number.isInteger(s.sixes) && s.sixes! >= 0 && s.sixes! <= 2 ? s.sixes! : 0;
    if (!positions) return null;
    return { ...core, positions, sixes, settings: normalizeSnakesSettings(s.settings) };
  },
  sideName: (_state, seat) => SNAKES_COLOR_NAMES[seat] ?? `Player ${seat + 1}`,
  rulesText: (settings) => [
    'Roll the die and move that many squares, from square 1 up to 100.',
    'Land on the foot of a ladder to climb it; land on a snake’s head to slide down to its tail.',
    settings.bounceBack
      ? 'A roll past 100 bounces back by the squares left over.'
      : 'You need the exact roll to reach 100; a roll past it does not move.',
    settings.sixRollsAgain
      ? 'A 6 gives you another roll (up to two extra in a row).'
      : 'One roll a turn.',
    'The first to reach 100 wins.',
  ],
  stepMs: (step, pace) => {
    if (step.kind !== 'roll' || step.die === undefined) return pace.read;
    const path = snakesPath(step.before.positions[step.seat]!, step.die, step.before.settings);
    if (path.walk.length === 0) return pace.read * 2;
    return path.walk.length * pace.hop + (path.jump ? pace.slide : 0) + pace.read;
  },
};
