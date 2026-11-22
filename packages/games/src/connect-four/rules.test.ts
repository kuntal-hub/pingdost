import { describe, expect, it } from 'vitest';

import {
  C4_COLUMNS,
  chooseConnectFourMove,
  CONNECT_FOUR,
  connectFourColor,
  landingRow,
  type ConnectFourState,
} from './rules';
import { seededRandom, type Random } from '../core/random';
import type { BotLevel } from '../core/types';

const drop = (state: ConnectFourState, ...columns: number[]) =>
  columns.reduce((s, column) => CONNECT_FOUR.apply(s, { column }), state);
const fresh = (first = 0) => CONNECT_FOUR.setup(2, {}, first);
const at = (row: number, col: number) => row * C4_COLUMNS + col;

function match(a: BotLevel, b: BotLevel, first: number, random: Random): number[] {
  let state = fresh(first);
  const levels = [a, b];
  while (!state.ranks) {
    state = CONNECT_FOUR.apply(state, chooseConnectFourMove(state, levels[state.current]!, random));
  }
  return state.ranks;
}

function wins(a: BotLevel, b: BotLevel, games: number, seed: number) {
  const random = seededRandom(seed);
  let won = 0;
  let lost = 0;
  for (let i = 0; i < games; i++) {
    const [mine, theirs] = match(a, b, i % 2, random) as [number, number];
    if (mine < theirs) won++;
    else if (mine > theirs) lost++;
  }
  return { won, lost };
}

describe('Connect Four', () => {
  it('drops discs to the lowest free row', () => {
    const state = drop(fresh(1), 3, 3);
    expect(state.cells[at(5, 3)]).toBe(1);
    expect(state.cells[at(4, 3)]).toBe(0);
    expect(landingRow(state.cells, 3)).toBe(3);
    expect(connectFourColor(state, 1)).toBe('red');
  });

  it('refuses a full column', () => {
    const full = drop(fresh(), 0, 0, 0, 0, 0, 0);
    expect(CONNECT_FOUR.isLegal(full, { column: 0 })).toBe(false);
    expect(CONNECT_FOUR.legal(full).map((m) => m.column)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(CONNECT_FOUR.apply(full, { column: 0 })).toBe(full);
  });

  it('finds four across, down and diagonally', () => {
    const across = drop(fresh(), 0, 0, 1, 1, 2, 2, 3);
    expect(across.ranks).toEqual([1, 2]);
    expect(across.line).toEqual([at(5, 0), at(5, 1), at(5, 2), at(5, 3)]);
    const down = drop(fresh(), 0, 1, 0, 1, 0, 1, 0);
    expect(down.ranks).toEqual([1, 2]);
    // Seat 0 builds the rising diagonal (5,0) (4,1) (3,2) (2,3).
    const diagonal = drop(fresh(), 0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3);
    expect(diagonal.ranks).toEqual([1, 2]);
    expect(diagonal.line).toHaveLength(4);
  });

  it('restores a saved state', () => {
    const state = drop(fresh(), 0, 0, 1, 1, 2, 2, 3);
    expect(CONNECT_FOUR.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('computer players take a win, block a loss, and the levels are ordered', () => {
    // Seat 0 has three across on the bottom row; seat 1 to move must block column 3.
    const threat = drop(fresh(), 0, 6, 1, 6, 2);
    expect(chooseConnectFourMove(threat, 'medium', seededRandom(1))).toEqual({ column: 3 });
    const win = drop(fresh(), 0, 6, 1, 6, 2, 5);
    expect(chooseConnectFourMove(win, 'easy', seededRandom(2)).column).toBeGreaterThanOrEqual(0);
    expect(chooseConnectFourMove(win, 'hard', seededRandom(3))).toEqual({ column: 3 });
    const mediumEasy = wins('medium', 'easy', 60, 4);
    expect(mediumEasy.won).toBeGreaterThan(mediumEasy.lost * 2);
    const hardMedium = wins('hard', 'medium', 30, 5);
    expect(hardMedium.won).toBeGreaterThan(hardMedium.lost);
  }, 60_000);
});
