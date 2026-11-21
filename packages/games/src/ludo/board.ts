// Ludo board geometry, shared by the phone and the web (ADR 0049).
//
// The board is 15×15 cells; x grows right, y grows down. Red's yard is bottom left, then
// clockwise green (top left), yellow (top right), blue (bottom right). The shared track has 52
// squares, numbered clockwise from red's start. A piece's *progress* counts from its own start:
//   -1        in the yard
//   0..50     on the track (its start square is 0)
//   51..55    in its home column
//   56        home (finished)

export const LUDO_COLORS = ['red', 'green', 'yellow', 'blue'] as const;
export type LudoColor = (typeof LUDO_COLORS)[number];

export const TRACK_LENGTH = 52;
export const YARD = -1;
/** The last track square before the home column. */
export const LAST_TRACK = 50;
export const HOME = 56;
export const BOARD_CELLS = 15;

/** A cell `[x, y]` on the 15×15 grid. */
export type Cell = readonly [number, number];

/** The 52 track squares, clockwise from red's start. */
export const TRACK: readonly Cell[] = buildTrack();

/** Where each color enters the track. */
export const START_INDEX: Record<LudoColor, number> = { red: 0, green: 13, yellow: 26, blue: 39 };

/** Start squares and stars: nobody is captured there. */
export const SAFE_INDEXES: ReadonlySet<number> = new Set(
  LUDO_COLORS.flatMap((color) => [START_INDEX[color], START_INDEX[color] + 8]),
);

/** The star squares (safe, drawn with a star). */
export const STAR_INDEXES: readonly number[] = LUDO_COLORS.map((c) => START_INDEX[c] + 8);

/** Each color's home column, from the track toward the center (progress 51..55). */
export const HOME_COLUMN: Record<LudoColor, readonly Cell[]> = {
  red: [0, 1, 2, 3, 4].map((i) => [7, 13 - i] as const),
  green: [0, 1, 2, 3, 4].map((i) => [1 + i, 7] as const),
  yellow: [0, 1, 2, 3, 4].map((i) => [7, 1 + i] as const),
  blue: [0, 1, 2, 3, 4].map((i) => [13 - i, 7] as const),
};

/** The top-left cell of each 6×6 yard. */
export const YARD_ORIGIN: Record<LudoColor, Cell> = {
  red: [0, 9],
  green: [0, 0],
  yellow: [9, 0],
  blue: [9, 9],
};

/** A point in cell units (a cell's center is `x + 0.5`), for drawing pieces. */
export interface Point {
  x: number;
  y: number;
}

/** The track index (0..51) of a piece at `progress`, or null off the shared track. */
export function trackIndex(color: LudoColor, progress: number): number | null {
  if (progress < 0 || progress > LAST_TRACK) return null;
  return (START_INDEX[color] + progress) % TRACK_LENGTH;
}

/** The cell a piece at `progress` stands on, or null in the yard or home. */
export function cellOf(color: LudoColor, progress: number): Cell | null {
  const index = trackIndex(color, progress);
  if (index !== null) return TRACK[index]!;
  if (progress > LAST_TRACK && progress < HOME) return HOME_COLUMN[color][progress - 51]!;
  return null;
}

/** The yard spot of piece `token` (0..3). */
export function yardPoint(color: LudoColor, token: number): Point {
  const [ox, oy] = YARD_ORIGIN[color];
  return { x: ox + (token % 2 === 0 ? 2 : 4), y: oy + (token < 2 ? 2 : 4) };
}

// The center triangle of each color, where finished pieces stand.
const HOME_POINT: Record<LudoColor, Point> = {
  red: { x: 7.5, y: 8.45 },
  green: { x: 6.55, y: 7.5 },
  yellow: { x: 7.5, y: 6.55 },
  blue: { x: 8.45, y: 7.5 },
};

/** Where finished piece `token` stands in the center. */
export function homePoint(color: LudoColor, token: number): Point {
  const base = HOME_POINT[color];
  const spread = (token - 1.5) * 0.28;
  const horizontal = color === 'red' || color === 'yellow';
  return horizontal ? { x: base.x + spread, y: base.y } : { x: base.x, y: base.y + spread };
}

/** The center of a piece at `progress` (yard spot, cell, or home spot). */
export function pointOf(color: LudoColor, token: number, progress: number): Point {
  if (progress === YARD) return yardPoint(color, token);
  if (progress >= HOME) return homePoint(color, token);
  const [x, y] = cellOf(color, progress)!;
  return { x: x + 0.5, y: y + 0.5 };
}

/** The points a piece passes moving from `from` to `to` (excluding `from`), for hop animation. */
export function pathPoints(color: LudoColor, token: number, from: number, to: number): Point[] {
  if (from === YARD) return [pointOf(color, token, to)];
  const points: Point[] = [];
  for (let progress = from + 1; progress <= to; progress++) {
    points.push(pointOf(color, token, progress));
  }
  return points;
}

/**
 * Turns the board so `color` sits bottom left, as the player sees it. Quarter turns go
 * counterclockwise; cell-unit points rotate about the center.
 */
export function rotationFor(color: LudoColor): number {
  return LUDO_COLORS.indexOf(color);
}

export function rotatePoint(point: Point, quarterTurns: number): Point {
  let { x, y } = point;
  for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) [x, y] = [y, BOARD_CELLS - x];
  return { x, y };
}

function buildTrack(): Cell[] {
  const cells: Cell[] = [];
  const add = (x: number, y: number): void => void cells.push([x, y]);
  for (let y = 13; y >= 9; y--) add(6, y); // up the bottom arm's left lane
  for (let x = 5; x >= 0; x--) add(x, 8); // out along the left arm's lower lane
  add(0, 7);
  for (let x = 0; x <= 5; x++) add(x, 6); // in along the left arm's upper lane
  for (let y = 5; y >= 0; y--) add(6, y); // up the top arm's left lane
  add(7, 0);
  for (let y = 0; y <= 5; y++) add(8, y); // down the top arm's right lane
  for (let x = 9; x <= 14; x++) add(x, 6); // out along the right arm's upper lane
  add(14, 7);
  for (let x = 14; x >= 9; x--) add(x, 8); // in along the right arm's lower lane
  for (let y = 9; y <= 14; y++) add(8, y); // down the bottom arm's right lane
  add(7, 14);
  add(6, 14);
  return cells;
}
