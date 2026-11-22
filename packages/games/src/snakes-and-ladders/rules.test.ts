import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SNAKES_SETTINGS,
  LADDERS,
  SNAKES,
  SNAKES_AND_LADDERS,
  snakesPath,
  type SnakesState,
} from './rules';
import { seededRandom } from '../core/random';

const rules = SNAKES_AND_LADDERS;
const roll = (state: SnakesState, ...dice: number[]) =>
  dice.reduce((s, d) => rules.roll!(s, d), state);

describe('Snakes and Ladders', () => {
  it('has a clean board: no square both a start and an end, nothing on 1 or 100', () => {
    const starts = [...LADDERS, ...SNAKES].map(([from]) => from);
    const ends = [...LADDERS, ...SNAKES].map(([, to]) => to);
    expect(new Set(starts).size).toBe(starts.length);
    for (const end of ends) expect(starts).not.toContain(end);
    expect(starts).not.toContain(1);
    expect(starts).not.toContain(100);
    for (const [from, to] of LADDERS) expect(to).toBeGreaterThan(from);
    for (const [from, to] of SNAKES) expect(to).toBeLessThan(from);
  });

  it('walks, climbs ladders and slides down snakes', () => {
    expect(snakesPath(0, 3, DEFAULT_SNAKES_SETTINGS)).toEqual({
      walk: [1, 2, 3],
      jump: { from: 3, to: 22, kind: 'ladder' },
      end: 22,
    });
    expect(snakesPath(14, 3, DEFAULT_SNAKES_SETTINGS).end).toBe(6);
    expect(snakesPath(10, 4, DEFAULT_SNAKES_SETTINGS)).toEqual({
      walk: [11, 12, 13, 14],
      jump: null,
      end: 14,
    });
  });

  it('needs the exact roll to finish, or bounces back', () => {
    expect(snakesPath(98, 4, DEFAULT_SNAKES_SETTINGS)).toEqual({ walk: [], jump: null, end: 98 });
    const bounce = { ...DEFAULT_SNAKES_SETTINGS, bounceBack: true };
    expect(snakesPath(98, 4, bounce)).toEqual({ walk: [99, 100, 99, 98], jump: null, end: 98 });
    // Bouncing onto a snake's head (97) slides down.
    expect(snakesPath(99, 4, bounce).end).toBe(78);
  });

  it('takes turns; a 6 rolls again only with the toggle, at most twice', () => {
    const state = roll(rules.setup(3, DEFAULT_SNAKES_SETTINGS, 1), 6);
    expect(state.positions).toEqual([0, 6, 0]);
    expect(state.current).toBe(2);
    const again = { ...DEFAULT_SNAKES_SETTINGS, sixRollsAgain: true };
    let s = roll(rules.setup(2, again, 0), 6);
    expect(s.current).toBe(0);
    s = roll(s, 6, 6);
    expect(s.current).toBe(1);
    expect(s.turns).toBe(3);
  });

  it('ends at 100: the winner first, the rest by square', () => {
    let state = rules.setup(3, DEFAULT_SNAKES_SETTINGS, 0);
    state = { ...state, positions: [96, 40, 60] };
    state = roll(state, 4);
    expect(state.ranks).toEqual([1, 3, 2]);
  });

  it('a whole game ends, and a saved state comes back', () => {
    const random = seededRandom(5);
    let state = rules.setup(4, DEFAULT_SNAKES_SETTINGS, 0);
    for (let i = 0; i < 10_000 && !state.ranks; i++) state = rules.roll!(state, random.die());
    expect(state.ranks).not.toBeNull();
    expect(state.positions).toContain(100);
    expect(rules.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
