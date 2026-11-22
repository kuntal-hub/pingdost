import { describe, expect, it } from 'vitest';

import {
  chooseDotsMove,
  DOTS_AND_BOXES,
  dotsGeometry,
  dotsLineAt,
  type DotsSize,
  type DotsState,
} from './rules';
import { seededRandom, type Random } from '../core/random';
import type { BotLevel } from '../core/types';

const draw = (state: DotsState, ...lines: number[]) =>
  lines.reduce((s, line) => DOTS_AND_BOXES.apply(s, { line }), state);

function match(levels: BotLevel[], size: DotsSize, first: number, random: Random): number[] {
  let state = DOTS_AND_BOXES.setup(levels.length, { size }, first);
  while (!state.ranks) {
    state = DOTS_AND_BOXES.apply(state, chooseDotsMove(state, levels[state.current]!, random));
  }
  return state.ranks;
}

function wins(a: BotLevel, b: BotLevel, size: DotsSize, games: number, seed: number) {
  const random = seededRandom(seed);
  let won = 0;
  let lost = 0;
  for (let i = 0; i < games; i++) {
    const [mine, theirs] = match([a, b], size, i % 2, random) as [number, number];
    if (mine < theirs) won++;
    else if (mine > theirs) lost++;
  }
  return { won, lost };
}

describe('Dots and Boxes', () => {
  it('numbers lines: horizontal rows, then vertical rows', () => {
    const geo = dotsGeometry(3);
    expect(geo.lineCount).toBe(24);
    expect(geo.boxLines[0]).toEqual([0, 3, 12, 13]);
    expect(geo.boxLines[8]).toEqual([8, 11, 22, 23]);
    expect(geo.lineBoxes[4]).toEqual([1, 4]);
    expect(geo.lineBoxes[12]).toEqual([0]);
    expect(dotsLineAt(3, 4)).toEqual({ horizontal: true, row: 1, col: 1 });
    expect(dotsLineAt(3, 17)).toEqual({ horizontal: false, row: 1, col: 1 });
  });

  it('a closed box scores and draws again', () => {
    let state = DOTS_AND_BOXES.setup(2, { size: 3 }, 0);
    state = draw(state, 0, 3, 12);
    expect(state.current).toBe(1);
    state = draw(state, 13);
    expect(state.boxes[0]).toBe(1);
    expect(state.scores).toEqual([0, 1]);
    expect(state.current).toBe(1);
    expect(DOTS_AND_BOXES.isLegal(state, { line: 13 })).toBe(false);
  });

  it('a line between two three-sided boxes closes both', () => {
    // Boxes 0 and 1 share line 13.
    let state = DOTS_AND_BOXES.setup(2, { size: 3 }, 0);
    state = draw(state, 0, 3, 12, 1, 4, 14);
    const before = state.current;
    state = draw(state, 13);
    expect(state.scores[before]).toBe(2);
  });

  it('ends when every box is closed, best score first; three players', () => {
    const ranks = match(['medium', 'medium', 'medium'], 3, 0, seededRandom(9));
    expect([...ranks].sort()).toContain(1);
    const geo = dotsGeometry(4);
    let state = DOTS_AND_BOXES.setup(3, { size: 4 }, 2);
    const random = seededRandom(10);
    while (!state.ranks) state = DOTS_AND_BOXES.apply(state, chooseDotsMove(state, 'easy', random));
    expect(state.scores.reduce((a, b) => a + b, 0)).toBe(geo.boxCount);
    const best = Math.max(...state.scores);
    state.scores.forEach((score, seat) => {
      if (score === best) expect(state.ranks![seat]).toBe(1);
    });
  });

  it('play goes on when one of three leaves; the last one in wins', () => {
    let state = DOTS_AND_BOXES.setup(3, { size: 3 }, 0);
    state = DOTS_AND_BOXES.leave(state, 0);
    expect(state.current).toBe(1);
    expect(state.ranks).toBeNull();
    state = DOTS_AND_BOXES.leave(state, 2);
    expect(state.ranks).toEqual([3, 1, 2]);
  });

  it('restores a saved state', () => {
    const state = draw(DOTS_AND_BOXES.setup(2, { size: 5 }, 1), 0, 7, 40);
    expect(DOTS_AND_BOXES.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(DOTS_AND_BOXES.restore({ ...state, lines: [0] })).toBeNull();
  });

  it('Hard double-deals the last two boxes of a chain while long chains remain', () => {
    // 3×3, every horizontal line drawn. The top row was a chain: box 2 is taken, box 1 has
    // three sides (open: 13, shared with box 0), box 0 two (open: 12 on the edge, and 13).
    // The middle and bottom rows are two more three-box chains. No line is safe.
    const open = new Set([12, 13, 16, 17, 18, 19, 20, 21, 22, 23]);
    const base = DOTS_AND_BOXES.setup(2, { size: 3 }, 0);
    const state: DotsState = {
      ...base,
      lines: base.lines.map((_, line) => (open.has(line) ? -1 : 0)),
      boxes: base.boxes.map((_, box) => (box === 2 ? 0 : -1)),
      scores: [1, 0],
    };
    // Medium takes box 1; Hard draws box 0's far side, handing over both boxes so the other
    // player must then open a long chain.
    expect(chooseDotsMove(state, 'medium', seededRandom(1))).toEqual({ line: 13 });
    expect(chooseDotsMove(state, 'hard', seededRandom(1))).toEqual({ line: 12 });
    // With nothing left to fight for, Hard just takes.
    const last: DotsState = { ...state, boxes: state.boxes.map((b, box) => (box >= 3 ? 1 : b)) };
    last.lines = last.lines.map((v, line) => (line >= 16 ? 1 : v));
    expect(chooseDotsMove(last, 'hard', seededRandom(1))).toEqual({ line: 13 });
  });

  it('computer players: Medium never gives a box while a safe line is left; levels are ordered', () => {
    let state = DOTS_AND_BOXES.setup(2, { size: 3 }, 0);
    state = draw(state, 0, 3);
    // Line 12 would give box 0 its third side; a medium player avoids it.
    for (let seed = 0; seed < 20; seed++) {
      expect(chooseDotsMove(state, 'medium', seededRandom(seed)).line).not.toBe(12);
    }
    const mediumEasy = wins('medium', 'easy', 4, 200, 11);
    expect(mediumEasy.won).toBeGreaterThan(mediumEasy.lost * 2);
    const hardMedium = wins('hard', 'medium', 4, 200, 12);
    expect(hardMedium.won).toBeGreaterThan(hardMedium.lost);
  }, 60_000);
});
