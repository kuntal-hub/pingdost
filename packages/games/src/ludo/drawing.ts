// What the Ludo board looks like, as plain shapes in board units (15×15), so the phone
// (react-native-svg) and the web (DOM SVG) draw the same board. Paints name roles; each app
// resolves them with `gameBoardColors` from ui-tokens.
import {
  HOME,
  HOME_COLUMN,
  homeCenter,
  LUDO_COLORS,
  pointOf,
  rotatePoint,
  START_INDEX,
  STAR_INDEXES,
  TRACK,
  YARD,
  YARD_ORIGIN,
  yardPoint,
  type LudoColor,
  type Point,
} from './board';
import type { LudoState } from './rules';

export type LudoPaint = 'board' | 'cell' | 'line' | `${LudoColor}.fill` | `${LudoColor}.soft`;

export type LudoShape =
  | {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
      fill: LudoPaint;
      /** A thin cell border in the `line` paint. */
      outlined?: boolean;
    }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: LudoPaint; ring?: LudoPaint }
  | { kind: 'polygon'; points: string; fill: LudoPaint; outlined?: boolean };

/** The width of cell borders, and of the yard spots' rings, in board units. */
export const LUDO_LINE_WIDTH = 0.04;
export const LUDO_RING_WIDTH = 0.1;

const CENTER_TRIANGLES: Record<LudoColor, string> = {
  red: '6,9 9,9 7.5,7.5',
  green: '6,6 6,9 7.5,7.5',
  yellow: '6,6 9,6 7.5,7.5',
  blue: '9,6 9,9 7.5,7.5',
};

function starPoints(x: number, y: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? 0.36 : 0.15;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + 0.5 + radius * Math.cos(angle);
    const py = y + 0.5 + radius * Math.sin(angle);
    points.push(`${px.toFixed(3)},${py.toFixed(3)}`);
  }
  return points.join(' ');
}

function buildShapes(): LudoShape[] {
  const shapes: LudoShape[] = [
    { kind: 'rect', x: 0, y: 0, width: 15, height: 15, rx: 0.45, fill: 'board' },
  ];
  for (const color of LUDO_COLORS) {
    const [x, y] = YARD_ORIGIN[color];
    shapes.push({
      kind: 'rect',
      x: x + 0.1,
      y: y + 0.1,
      width: 5.8,
      height: 5.8,
      rx: 0.45,
      fill: `${color}.fill`,
    });
    shapes.push({
      kind: 'rect',
      x: x + 0.8,
      y: y + 0.8,
      width: 4.4,
      height: 4.4,
      rx: 0.4,
      fill: `${color}.soft`,
    });
    for (let token = 0; token < 4; token++) {
      const spot = yardPoint(color, token);
      shapes.push({
        kind: 'circle',
        cx: spot.x,
        cy: spot.y,
        r: 0.62,
        fill: 'cell',
        ring: `${color}.fill`,
      });
    }
  }
  const starts = new Map(LUDO_COLORS.map((color) => [START_INDEX[color], color]));
  const stars = new Set(STAR_INDEXES);
  TRACK.forEach(([x, y], index) => {
    const start = starts.get(index);
    shapes.push({
      kind: 'rect',
      x,
      y,
      width: 1,
      height: 1,
      fill: start ? `${start}.fill` : 'cell',
      outlined: true,
    });
    if (stars.has(index)) shapes.push({ kind: 'polygon', points: starPoints(x, y), fill: 'line' });
  });
  for (const color of LUDO_COLORS) {
    for (const [x, y] of HOME_COLUMN[color]) {
      shapes.push({
        kind: 'rect',
        x,
        y,
        width: 1,
        height: 1,
        fill: `${color}.fill`,
        outlined: true,
      });
    }
    shapes.push({
      kind: 'polygon',
      points: CENTER_TRIANGLES[color],
      fill: `${color}.fill`,
      outlined: true,
    });
  }
  return shapes;
}

/** Every shape of the board, back to front. */
export const LUDO_BOARD_SHAPES: readonly LudoShape[] = buildShapes();

/**
 * A piece: a shaded map pin standing on its square (ADR 0050). Coordinates are in cells,
 * relative to the square's center; scale them by the cell size and the stack's scale.
 */
export const LUDO_PIN = {
  /** The pin outline: a round head over a point that touches the square. */
  path: 'M 0 0.3 L -0.21 0.094 A 0.3 0.3 0 1 1 0.21 0.094 Z',
  head: { cx: 0, cy: -0.12, r: 0.3 },
  /** The white disc in the head that carries the color-blind shape. */
  face: { cx: 0, cy: -0.12, r: 0.17 },
  /** The shape glyph's width. */
  glyph: 0.19,
  /** A soft gloss on the upper left of the head. */
  gloss: { cx: -0.1, cy: -0.25, rx: 0.08, ry: 0.05 },
  /** The ground shadow, and the ring that pulses under a piece that can move. */
  shadow: { cx: 0, cy: 0.3, rx: 0.23, ry: 0.075 },
  ring: { cx: 0, cy: 0.3, rx: 0.36, ry: 0.13 },
  /** The box the pin occupies: x −0.36..0.36, y −0.43..0.43. */
  box: { x: -0.36, y: -0.43, width: 0.72, height: 0.86 },
  /** Radial gradient stops (light → fill → dark), as offsets. */
  gradient: { cx: 0.35, cy: 0.3, r: 0.85, stops: [0, 0.55, 1] },
} as const;

/** How a piece is drawn: where, how big, and its place in a stack. */
export interface LudoStackPiece {
  seat: number;
  color: LudoColor;
  token: number;
  progress: number;
  /** The center of the square it stands on (cell units, turned), plus its stack offset. */
  x: number;
  y: number;
  scale: number;
  /** 0 at the bottom of its stack. */
  layer: number;
  /** Pieces of its color on its square (1 when alone). */
  count: number;
  /** The top piece of a stack of two or more carries the count badge. */
  top: boolean;
}

/**
 * Every piece's drawing position (ADR 0050): pieces of one color on one square stack with a
 * count; different colors on one (safe) square sit side by side; finished pieces stack in
 * their home triangle; waiting pieces keep their own yard spot.
 */
export function ludoStacks(state: LudoState, quarterTurns: number): LudoStackPiece[] {
  const squares = new Map<
    string,
    { seat: number; color: LudoColor; token: number; progress: number; at: Point }[]
  >();
  const pieces: LudoStackPiece[] = [];
  state.players.forEach((player, seat) => {
    if (player.left) return;
    player.tokens.forEach((progress, token) => {
      if (progress === YARD) {
        const at = rotatePoint(yardPoint(player.color, token), quarterTurns);
        pieces.push({
          seat,
          color: player.color,
          token,
          progress,
          x: at.x,
          y: at.y,
          scale: 1,
          layer: 0,
          count: 1,
          top: false,
        });
        return;
      }
      const at = rotatePoint(
        progress >= HOME ? homeCenter(player.color) : pointOf(player.color, token, progress),
        quarterTurns,
      );
      const key = `${at.x.toFixed(2)},${at.y.toFixed(2)}`;
      squares.set(key, [
        ...(squares.get(key) ?? []),
        { seat, color: player.color, token, progress, at },
      ]);
    });
  });
  for (const here of squares.values()) {
    const colors = [...new Set(here.map((p) => p.color))];
    colors.forEach((color, slot) => {
      const stack = here.filter((p) => p.color === color);
      const { dx, dy, scale } = sideBySide(colors.length, slot);
      stack.forEach((p, layer) => {
        pieces.push({
          seat: p.seat,
          color,
          token: p.token,
          progress: p.progress,
          x: p.at.x + dx,
          // Each piece in a stack sits a little higher, so the stack looks piled.
          y: p.at.y + dy - layer * 0.07 * scale,
          scale,
          layer,
          count: stack.length,
          top: stack.length > 1 && layer === stack.length - 1,
        });
      });
    });
  }
  return pieces;
}

function sideBySide(count: number, slot: number): { dx: number; dy: number; scale: number } {
  if (count <= 1) return { dx: 0, dy: 0, scale: 1 };
  if (count === 2) return { dx: slot === 0 ? -0.2 : 0.2, dy: 0, scale: 0.78 };
  const spots = [
    [-0.2, -0.17],
    [0.2, -0.17],
    [-0.2, 0.19],
    [0.2, 0.19],
  ] as const;
  const [dx, dy] = spots[slot % 4]!;
  return { dx, dy, scale: 0.64 };
}

/** A paint's color from a palette shaped like ui-tokens' `GameBoardColors`. */
export function resolveLudoPaint(
  paint: LudoPaint,
  colors: {
    board: string;
    cell: string;
    line: string;
    players: Record<LudoColor, { fill: string; soft: string }>;
  },
): string {
  if (paint === 'board' || paint === 'cell' || paint === 'line') return colors[paint];
  const [color, part] = paint.split('.') as [LudoColor, 'fill' | 'soft'];
  return colors.players[color][part];
}
