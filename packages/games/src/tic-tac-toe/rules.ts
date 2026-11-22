// Tic-Tac-Toe (Phase 43): three in a row on 3 by 3. Whoever moves first plays X. Computer
// players: Easy plays mostly at random, Medium looks one move ahead each way (wins, blocks),
// Hard plays perfectly (minimax), so it never loses.
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

export type TicTacToeSettings = Record<string, never>;

export interface TicTacToeState extends TurnCore {
  /** Row by row from the top left: −1 empty, else the seat. */
  cells: number[];
  /** The seat that moved first: it plays X. */
  first: number;
  /** The three cells in a row, once someone has them. */
  line: number[] | null;
  settings: TicTacToeSettings;
}

export interface TicTacToeMove {
  cell: number;
}

export const TIC_TAC_TOE_LINES: readonly (readonly number[])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/** "X" or "O" for a seat. */
export function ticTacToeMark(state: Pick<TicTacToeState, 'first'>, seat: number): 'X' | 'O' {
  return seat === state.first ? 'X' : 'O';
}

function winningLine(cells: readonly number[]): number[] | null {
  for (const line of TIC_TAC_TOE_LINES) {
    const [a, b, c] = line as [number, number, number];
    if (cells[a]! >= 0 && cells[a] === cells[b] && cells[a] === cells[c]) return [...line];
  }
  return null;
}

function setup(seats: number, settings: TicTacToeSettings, first: number): TicTacToeState {
  return {
    ...turnCore(seats, first),
    cells: Array.from({ length: 9 }, () => -1),
    first,
    line: null,
    settings,
  };
}

function legal(state: TicTacToeState): TicTacToeMove[] {
  if (state.ranks) return [];
  return state.cells.flatMap((v, cell) => (v < 0 ? [{ cell }] : []));
}

function isLegal(state: TicTacToeState, move: TicTacToeMove): boolean {
  return (
    !state.ranks &&
    Number.isInteger(move.cell) &&
    move.cell >= 0 &&
    move.cell < 9 &&
    state.cells[move.cell] === -1
  );
}

function apply(state: TicTacToeState, move: TicTacToeMove): TicTacToeState {
  if (!isLegal(state, move)) return state;
  const cells = [...state.cells];
  cells[move.cell] = state.current;
  const next: TicTacToeState = { ...state, cells, turns: state.turns + 1 };
  const line = winningLine(cells);
  if (line) return { ...next, line, ranks: placesWithWinner(next, state.current) };
  if (cells.every((v) => v >= 0)) return { ...next, ranks: placesDraw(next) };
  return { ...next, current: 1 - state.current };
}

// Computer players

/**
 * The outcome for `me`: +(10 − plies) win, −(10 − plies) loss, 0 draw. Positions repeat a lot,
 * so each search keeps a table (the plies follow from the position for a given root).
 */
function minimax(
  cells: number[],
  me: number,
  toMove: number,
  depth: number,
  limit: number,
  memo: Map<string, number>,
): number {
  const line = winningLine(cells);
  if (line) return cells[line[0]!] === me ? 10 - depth : depth - 10;
  if (depth >= limit || cells.every((v) => v >= 0)) return 0;
  const key = cells.join('');
  const known = memo.get(key);
  if (known !== undefined) return known;
  let best = toMove === me ? -Infinity : Infinity;
  for (let i = 0; i < 9; i++) {
    if (cells[i] !== -1) continue;
    cells[i] = toMove;
    const score = minimax(cells, me, 1 - toMove, depth + 1, limit, memo);
    cells[i] = -1;
    best = toMove === me ? Math.max(best, score) : Math.min(best, score);
  }
  memo.set(key, best);
  return best;
}

function bestMoves(state: TicTacToeState, limit: number): number[] {
  const me = state.current;
  const cells = [...state.cells];
  const memo = new Map<string, number>();
  let best = -Infinity;
  let moves: number[] = [];
  for (let i = 0; i < 9; i++) {
    if (cells[i] !== -1) continue;
    cells[i] = me;
    const score = minimax(cells, me, 1 - me, 1, limit, memo);
    cells[i] = -1;
    if (score > best) {
      best = score;
      moves = [i];
    } else if (score === best) {
      moves.push(i);
    }
  }
  return moves;
}

export function chooseTicTacToeMove(
  state: TicTacToeState,
  level: BotLevel,
  random: Random,
): TicTacToeMove {
  const open = legal(state).map((m) => m.cell);
  const pick = (cells: number[]) => ({ cell: cells[random.int(cells.length)]! });
  if (open.length === 0) return { cell: 0 };
  switch (level) {
    case 'easy':
      // Takes a win it sees half the time; otherwise anywhere.
      return random.next() < 0.5 ? pick(bestMoves(state, 1)) : pick(open);
    case 'medium':
      // Sees its own win and the other's next win, nothing deeper.
      return pick(bestMoves(state, 2));
    case 'hard':
      // On an empty board every square draws with best play: skip the biggest search.
      if (open.length === 9) return pick([0, 2, 4, 6, 8]);
      return pick(bestMoves(state, 9));
  }
}

export const TIC_TAC_TOE: TurnRules<TicTacToeState, TicTacToeMove, TicTacToeSettings> = {
  id: 'tic-tac-toe',
  wireType: GameType.TIC_TAC_TOE,
  minPlayers: 2,
  maxPlayers: 2,
  dice: false,
  levels: true,
  turnMs: 30_000,
  defaultSettings: {},
  normalizeSettings: () => ({}),
  settingsToWire: () => ({ case: 'ticTacToe', value: {} }),
  settingsFromWire: () => ({}),
  setup,
  legal,
  isLegal,
  apply,
  skip: passTurn,
  leave: (state, seat) => leaveSeat(state, seat),
  bot: chooseTicTacToeMove,
  proxy: (state, random) => chooseTicTacToeMove(state, 'medium', random),
  moveToWire: (move) => ({ case: 'ticTacToe', value: { cell: move.cell } }),
  moveFromWire: (wire) => (wire.play.case === 'ticTacToe' ? { cell: wire.play.value.cell } : null),
  sameMove: (a, b) => a.cell === b.cell,
  canonical: (s) =>
    `${s.current}|${s.turns}|${s.first}|${s.cells.join(',')}|${s.left.map(Number).join('')}|${s.ranks?.join(',') ?? '-'}`,
  restore(raw) {
    const core = restoreCore(raw, 2, 2);
    if (!core) return null;
    const s = raw as Partial<TicTacToeState>;
    const cells = intArray(s.cells, 9, -1, 1);
    if (!cells || (s.first !== 0 && s.first !== 1)) return null;
    return { ...core, cells, first: s.first, line: winningLine(cells), settings: {} };
  },
  sideName: (state, seat) => ticTacToeMark(state, seat),
  rulesText: () => [
    'Take turns putting your mark in an empty square. Whoever moves first plays X.',
    'Three in a row (across, down or diagonally) wins.',
    'A full board with no three in a row is a draw.',
  ],
};
