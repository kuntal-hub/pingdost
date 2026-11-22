// Connect Four (Phase 43): 7 columns by 6 rows; drop discs, four in a row wins. Whoever drops
// first plays red. Computer players search ahead with alpha-beta (Easy 2 plies with slips,
// Medium 4, Hard 6) over a count of open fours.
import { GameType } from '@pingdost/protocol';

import type { Random } from '../core/random';
import {
  intArray,
  leaveSeat,
  passTurn,
  placesDraw,
  placesWithWinner,
  restoreCore,
  turnCore,
  type TurnCore,
  type TurnRules,
} from '../core/turn';
import type { BotLevel } from '../core/types';

export const C4_COLUMNS = 7;
export const C4_ROWS = 6;

export type ConnectFourSettings = Record<string, never>;

export interface ConnectFourState extends TurnCore {
  /** Row by row from the top (row 0) to the bottom (row 5): −1 empty, else the seat. */
  cells: number[];
  /** The seat that dropped first: it plays red. */
  first: number;
  /** The four cells in a row, once someone has them. */
  line: number[] | null;
  settings: ConnectFourSettings;
}

export interface ConnectFourMove {
  column: number;
}

/** The two disc colors, by who dropped first. */
export function connectFourColor(
  state: Pick<ConnectFourState, 'first'>,
  seat: number,
): 'red' | 'yellow' {
  return seat === state.first ? 'red' : 'yellow';
}

const at = (row: number, col: number) => row * C4_COLUMNS + col;

/** The row a disc dropped in `column` lands on, or −1 if the column is full. */
export function landingRow(cells: readonly number[], column: number): number {
  for (let row = C4_ROWS - 1; row >= 0; row--) if (cells[at(row, column)] === -1) return row;
  return -1;
}

const DIRECTIONS: readonly [number, number][] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** Four in a row through (row, col) for its owner, or null. */
function lineThrough(cells: ArrayLike<number>, row: number, col: number): number[] | null {
  const who = cells[at(row, col)];
  if (who === undefined || who < 0) return null;
  for (const [dr, dc] of DIRECTIONS) {
    const line = [at(row, col)];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLUMNS && cells[at(r, c)] === who) {
        line.push(at(r, c));
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= 4) return line.sort((a, b) => a - b).slice(0, 4);
  }
  return null;
}

function setup(seats: number, settings: ConnectFourSettings, first: number): ConnectFourState {
  return {
    ...turnCore(seats, first),
    cells: Array.from({ length: C4_COLUMNS * C4_ROWS }, () => -1),
    first,
    line: null,
    settings,
  };
}

function legal(state: ConnectFourState): ConnectFourMove[] {
  if (state.ranks) return [];
  return Array.from({ length: C4_COLUMNS }, (_, column) => column)
    .filter((column) => state.cells[at(0, column)] === -1)
    .map((column) => ({ column }));
}

function isLegal(state: ConnectFourState, move: ConnectFourMove): boolean {
  return (
    !state.ranks &&
    Number.isInteger(move.column) &&
    move.column >= 0 &&
    move.column < C4_COLUMNS &&
    state.cells[at(0, move.column)] === -1
  );
}

function apply(state: ConnectFourState, move: ConnectFourMove): ConnectFourState {
  if (!isLegal(state, move)) return state;
  const row = landingRow(state.cells, move.column);
  const cells = [...state.cells];
  cells[at(row, move.column)] = state.current;
  const next: ConnectFourState = { ...state, cells, turns: state.turns + 1 };
  const line = lineThrough(cells, row, move.column);
  if (line) return { ...next, line, ranks: placesWithWinner(next, state.current) };
  if (cells.every((v) => v >= 0)) return { ...next, ranks: placesDraw(next) };
  return { ...next, current: 1 - state.current };
}

// Computer players

const WIN = 1_000_000;
const ORDER = [3, 2, 4, 1, 5, 0, 6];

/** Every window of four cells, once. */
const WINDOWS: readonly number[][] = (() => {
  const out: number[][] = [];
  for (let row = 0; row < C4_ROWS; row++) {
    for (let col = 0; col < C4_COLUMNS; col++) {
      for (const [dr, dc] of DIRECTIONS) {
        const endRow = row + dr * 3;
        const endCol = col + dc * 3;
        if (endRow < 0 || endRow >= C4_ROWS || endCol < 0 || endCol >= C4_COLUMNS) continue;
        out.push([0, 1, 2, 3].map((i) => at(row + dr * i, col + dc * i)));
      }
    }
  }
  return out;
})();

/** The position for `me`: open threes and twos, the center column. */
function evaluate(cells: Int8Array, me: number): number {
  let score = 0;
  for (let row = 0; row < C4_ROWS; row++) {
    const v = cells[at(row, 3)]!;
    if (v === me) score += 3;
    else if (v >= 0) score -= 3;
  }
  for (const window of WINDOWS) {
    let mine = 0;
    let theirs = 0;
    for (const cell of window) {
      const v = cells[cell]!;
      if (v === me) mine++;
      else if (v >= 0) theirs++;
    }
    if (mine > 0 && theirs > 0) continue;
    if (mine === 3) score += 5;
    else if (mine === 2) score += 2;
    else if (theirs === 3) score -= 4;
    else if (theirs === 2) score -= 1;
  }
  return score;
}

function negamax(
  cells: Int8Array,
  heights: Int8Array,
  toMove: number,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
): number {
  if (depth === 0) return evaluate(cells, toMove);
  let best = -Infinity;
  let any = false;
  for (const col of ORDER) {
    const row = heights[col]!;
    if (row < 0) continue;
    any = true;
    cells[at(row, col)] = toMove;
    heights[col] = row - 1;
    let score: number;
    if (lineThrough(cells, row, col)) score = WIN - ply;
    else score = -negamax(cells, heights, 1 - toMove, depth - 1, -beta, -alpha, ply + 1);
    cells[at(row, col)] = -1;
    heights[col] = row;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return any ? best : 0;
}

/** Each column's score for the player to move (null: full). */
export function connectFourScores(state: ConnectFourState, depth: number): (number | null)[] {
  const cells = Int8Array.from(state.cells);
  const heights = Int8Array.from({ length: C4_COLUMNS }, (_, col) => landingRow(state.cells, col));
  const me = state.current;
  return Array.from({ length: C4_COLUMNS }, (_, col) => {
    const row = heights[col]!;
    if (row < 0) return null;
    cells[at(row, col)] = me;
    heights[col] = row - 1;
    const score = lineThrough(cells, row, col)
      ? WIN
      : -negamax(cells, heights, 1 - me, depth - 1, -Infinity, Infinity, 1);
    cells[at(row, col)] = -1;
    heights[col] = row;
    return score;
  });
}

const DEPTH: Record<BotLevel, number> = { easy: 2, medium: 4, hard: 6 };

export function chooseConnectFourMove(
  state: ConnectFourState,
  level: BotLevel,
  random: Random,
): ConnectFourMove {
  const open = legal(state).map((m) => m.column);
  if (open.length === 0) return { column: 0 };
  // Easy slips now and then: a column at random.
  if (level === 'easy' && random.next() < 0.3) return { column: open[random.int(open.length)]! };
  const scores = connectFourScores(state, DEPTH[level]);
  let best = -Infinity;
  for (const s of scores) if (s !== null && s > best) best = s;
  const top = scores.flatMap((s, col) => (s === best ? [col] : []));
  return { column: top[random.int(top.length)]! };
}

export const CONNECT_FOUR: TurnRules<ConnectFourState, ConnectFourMove, ConnectFourSettings> = {
  id: 'connect-four',
  wireType: GameType.CONNECT_FOUR,
  minPlayers: 2,
  maxPlayers: 2,
  dice: false,
  levels: true,
  turnMs: 30_000,
  defaultSettings: {},
  normalizeSettings: () => ({}),
  settingsToWire: () => ({ case: 'connectFour', value: {} }),
  settingsFromWire: () => ({}),
  setup,
  legal,
  isLegal,
  apply,
  skip: passTurn,
  leave: (state, seat) => leaveSeat(state, seat),
  bot: chooseConnectFourMove,
  proxy: (state, random) => chooseConnectFourMove(state, 'medium', random),
  moveToWire: (move) => ({ case: 'connectFour', value: { column: move.column } }),
  moveFromWire: (wire) =>
    wire.play.case === 'connectFour' ? { column: wire.play.value.column } : null,
  sameMove: (a, b) => a.column === b.column,
  canonical: (s) =>
    `${s.current}|${s.turns}|${s.first}|${s.cells.join(',')}|${s.left.map(Number).join('')}|${s.ranks?.join(',') ?? '-'}`,
  restore(raw) {
    const core = restoreCore(raw, 2, 2);
    if (!core) return null;
    const s = raw as Partial<ConnectFourState>;
    const cells = intArray(s.cells, C4_COLUMNS * C4_ROWS, -1, 1);
    if (!cells || (s.first !== 0 && s.first !== 1)) return null;
    let line: number[] | null = null;
    for (let i = 0; i < cells.length && !line; i++) {
      if (cells[i]! >= 0) line = lineThrough(cells, Math.floor(i / C4_COLUMNS), i % C4_COLUMNS);
    }
    return { ...core, cells, first: s.first, line, settings: {} };
  },
  sideName: (state, seat) => (connectFourColor(state, seat) === 'red' ? 'Red' : 'Yellow'),
  rulesText: () => [
    'Take turns dropping a disc into a column; it falls to the lowest free space.',
    'Four of your discs in a row (across, down or diagonally) win.',
    'A full board with no four in a row is a draw.',
  ],
  stepMs: (step, pace) => {
    if (step.kind === 'leave' || !step.move) return pace.read;
    // The disc falls further into an emptier column.
    const row = landingRow(step.before.cells, step.move.column);
    return pace.step + Math.max(0, row) * (pace.hop / 3);
  },
};
