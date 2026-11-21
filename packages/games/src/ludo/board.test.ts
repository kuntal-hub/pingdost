import { describe, expect, it } from 'vitest';

import {
  cellOf,
  cornerOf,
  HOME,
  HOME_COLUMN,
  homeCenter,
  LUDO_COLORS,
  pathPoints,
  pointOf,
  rotatePoint,
  rotationFor,
  SAFE_INDEXES,
  START_INDEX,
  STAR_INDEXES,
  TRACK,
  TRACK_LENGTH,
  trackIndex,
  YARD,
  YARD_ORIGIN,
  type Cell,
} from './board';
import { LUDO_BOARD_SHAPES, ludoStacks, resolveLudoPaint } from './drawing';
import { setupLudo, type LudoState } from './rules';

const near = (a: Cell, b: Cell): boolean =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) === 1;
const inYard = ([x, y]: Cell): boolean => (x < 6 || x > 8) && (y < 6 || y > 8);
const inCenter = ([x, y]: Cell): boolean => x >= 6 && x <= 8 && y >= 6 && y <= 8;

describe('ludo board', () => {
  it('has a closed track of 52 distinct squares, each next to the one before', () => {
    expect(TRACK).toHaveLength(TRACK_LENGTH);
    expect(new Set(TRACK.map(([x, y]) => `${x},${y}`)).size).toBe(TRACK_LENGTH);
    TRACK.forEach((cell, i) => {
      expect(near(cell, TRACK[(i + 1) % TRACK_LENGTH]!), `square ${i}`).toBe(true);
      expect(inYard(cell) || inCenter(cell), `square ${i}`).toBe(false);
    });
  });

  it('starts each color beside its own yard and spaces the starts evenly', () => {
    for (const color of LUDO_COLORS) {
      const [x, y] = TRACK[START_INDEX[color]]!;
      const [ox, oy] = YARD_ORIGIN[color];
      const touchesYard = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].some(([cx, cy]) => cx! >= ox && cx! < ox + 6 && cy! >= oy && cy! < oy + 6);
      expect(touchesYard, color).toBe(true);
    }
    expect(Object.values(START_INDEX)).toEqual([0, 13, 26, 39]);
    expect(SAFE_INDEXES.size).toBe(8);
    expect(STAR_INDEXES).toEqual([8, 21, 34, 47]);
  });

  it('leads each home column from the last track square into the center', () => {
    for (const color of LUDO_COLORS) {
      const column = HOME_COLUMN[color];
      expect(column).toHaveLength(5);
      expect(near(TRACK[trackIndex(color, 50)!]!, column[0]!), color).toBe(true);
      column.forEach((cell, i) => {
        if (i > 0) expect(near(column[i - 1]!, cell)).toBe(true);
        expect(TRACK.some(([x, y]) => x === cell[0] && y === cell[1])).toBe(false);
      });
      const last = column[4]!;
      expect(inCenter(last)).toBe(false);
      expect(
        [6, 7, 8].some((x) => [6, 7, 8].some((y) => near(last, [x, y]))),
        `${color} reaches the center`,
      ).toBe(true);
    }
  });

  it('maps progress to squares', () => {
    expect(trackIndex('green', 0)).toBe(13);
    expect(trackIndex('blue', 20)).toBe((39 + 20) % 52);
    expect(trackIndex('red', 51)).toBeNull();
    expect(cellOf('red', YARD)).toBeNull();
    expect(cellOf('red', HOME)).toBeNull();
    expect(cellOf('yellow', 55)).toEqual(HOME_COLUMN.yellow[4]);
    expect(pointOf('red', 0, 0)).toEqual({ x: 6.5, y: 13.5 });
  });

  it('lists every square of a hop, and one for leaving the yard', () => {
    expect(pathPoints('red', 0, YARD, 0)).toHaveLength(1);
    expect(pathPoints('red', 0, 3, 9)).toHaveLength(6);
    expect(pathPoints('blue', 1, 50, 56).at(-1)).toEqual(pointOf('blue', 1, HOME));
  });

  it('describes the board as shapes both apps draw the same way', () => {
    // Board, 4 yards (2 rects + 4 spots), 52 squares, 4 stars, 4 home columns of 5, 4 triangles.
    expect(LUDO_BOARD_SHAPES).toHaveLength(1 + 4 * 6 + 52 + 4 + 4 * 5 + 4);
    const colors = {
      board: 'B',
      cell: 'C',
      line: 'L',
      players: Object.fromEntries(
        LUDO_COLORS.map((c) => [c, { fill: `${c}F`, soft: `${c}S` }]),
      ) as Record<(typeof LUDO_COLORS)[number], { fill: string; soft: string }>,
    };
    expect(resolveLudoPaint('cell', colors)).toBe('C');
    expect(resolveLudoPaint('blue.soft', colors)).toBe('blueS');
  });

  it('stacks pieces of one color with a count, and puts colors side by side', () => {
    const base = setupLudo(['red', 'green', 'yellow']);
    // Red: two pieces on track 10, one home; green: one piece on track 13 (its start, safe),
    // red's fourth piece also on track 13; yellow waits in its yard.
    const state: LudoState = {
      ...base,
      players: base.players.map((p) =>
        p.color === 'red'
          ? { ...p, tokens: [10, 10, HOME, 13] }
          : p.color === 'green'
            ? { ...p, tokens: [0, YARD, YARD, YARD] }
            : p,
      ),
    };
    const pieces = ludoStacks(state, 0);
    expect(pieces).toHaveLength(12);
    const red = pieces.filter((p) => p.color === 'red');
    const pair = red.filter((p) => p.progress === 10);
    expect(pair.map((p) => p.count)).toEqual([2, 2]);
    expect(pair.map((p) => p.top)).toEqual([false, true]);
    expect(pair[1]!.y).toBeLessThan(pair[0]!.y);
    const shared = pieces.filter(
      (p) => p.progress !== YARD && (p.token === 3 || p.color === 'green'),
    );
    expect(shared.map((p) => p.scale)).toEqual([0.78, 0.78]);
    expect(Math.abs(shared[0]!.x - shared[1]!.x)).toBeCloseTo(0.4);
    expect(red.find((p) => p.progress === HOME)).toMatchObject(homeCenter('red'));
    expect(pieces.filter((p) => p.color === 'yellow').every((p) => p.count === 1 && !p.top)).toBe(
      true,
    );
  });

  it('puts every player in the corner of their yard, the user bottom left', () => {
    expect(cornerOf('red', 0)).toEqual({ top: false, left: true });
    expect(cornerOf('yellow', 0)).toEqual({ top: true, left: false });
    for (const color of LUDO_COLORS) {
      expect(cornerOf(color, rotationFor(color)), color).toEqual({ top: false, left: true });
    }
  });

  it('turns the board so the player sits bottom left', () => {
    for (const color of LUDO_COLORS) {
      const [ox, oy] = YARD_ORIGIN[color];
      const center = rotatePoint({ x: ox + 3, y: oy + 3 }, rotationFor(color));
      expect(center, color).toEqual({ x: 3, y: 12 });
    }
    expect(rotatePoint({ x: 2.5, y: 4 }, 4)).toEqual({ x: 2.5, y: 4 });
  });
});
