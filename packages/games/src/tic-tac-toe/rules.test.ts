import { describe, expect, it } from 'vitest';

import { chooseTicTacToeMove, TIC_TAC_TOE, ticTacToeMark, type TicTacToeState } from './rules';
import { seededRandom, type Random } from '../core/random';
import type { BotLevel } from '../core/types';

const play = (state: TicTacToeState, ...cells: number[]) =>
  cells.reduce((s, cell) => TIC_TAC_TOE.apply(s, { cell }), state);

function match(a: BotLevel, b: BotLevel, first: number, random: Random): number[] {
  let state = TIC_TAC_TOE.setup(2, {}, first);
  const levels = [a, b];
  while (!state.ranks)
    state = TIC_TAC_TOE.apply(state, chooseTicTacToeMove(state, levels[state.current]!, random));
  return state.ranks;
}

/** Wins, draws and losses for seat 0 over `games` games, each side starting half the time. */
function tally(a: BotLevel, b: BotLevel, games: number, seed: number) {
  const random = seededRandom(seed);
  const out = { won: 0, drawn: 0, lost: 0 };
  for (let i = 0; i < games; i++) {
    const [mine, theirs] = match(a, b, i % 2, random) as [number, number];
    if (mine === theirs) out.drawn++;
    else if (mine === 1) out.won++;
    else out.lost++;
  }
  return out;
}

describe('Tic-Tac-Toe', () => {
  it('plays marks in turn, X first', () => {
    const state = play(TIC_TAC_TOE.setup(2, {}, 1), 4);
    expect(state.cells[4]).toBe(1);
    expect(ticTacToeMark(state, 1)).toBe('X');
    expect(ticTacToeMark(state, 0)).toBe('O');
    expect(state.current).toBe(0);
    expect(TIC_TAC_TOE.isLegal(state, { cell: 4 })).toBe(false);
    expect(TIC_TAC_TOE.legal(state)).toHaveLength(8);
  });

  it('ends on three in a row and on a full board', () => {
    const won = play(TIC_TAC_TOE.setup(2, {}, 0), 0, 3, 1, 4, 2);
    expect(won.ranks).toEqual([1, 2]);
    expect(won.line).toEqual([0, 1, 2]);
    expect(TIC_TAC_TOE.legal(won)).toEqual([]);
    // X O X / X O O / O X X
    const drawn = play(TIC_TAC_TOE.setup(2, {}, 0), 0, 1, 2, 4, 3, 5, 7, 6, 8);
    expect(drawn.ranks).toEqual([1, 1]);
    expect(drawn.line).toBeNull();
  });

  it('gives the game to the one who stays', () => {
    const state = TIC_TAC_TOE.leave(play(TIC_TAC_TOE.setup(2, {}, 0), 4), 0);
    expect(state.ranks).toEqual([2, 1]);
  });

  it('restores a saved state and rejects a broken one', () => {
    const state = play(TIC_TAC_TOE.setup(2, {}, 0), 0, 3, 1, 4, 2);
    expect(TIC_TAC_TOE.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(TIC_TAC_TOE.restore({ ...state, cells: [1, 2] })).toBeNull();
  });

  it('computer players: Medium blocks, Hard never loses, the levels are ordered', () => {
    // O to move must block X's top row.
    const threat = play(TIC_TAC_TOE.setup(2, {}, 0), 0, 4, 1);
    expect(chooseTicTacToeMove(threat, 'medium', seededRandom(1))).toEqual({ cell: 2 });
    expect(tally('hard', 'medium', 200, 2).lost).toBe(0);
    expect(tally('hard', 'easy', 200, 3).lost).toBe(0);
    const mediumEasy = tally('medium', 'easy', 400, 4);
    expect(mediumEasy.won).toBeGreaterThan(mediumEasy.lost * 2);
  }, 60_000);
});
