// What the Ludo board looks like, as plain shapes in board units (15×15), so the phone
// (react-native-svg) and the web (DOM SVG) draw the same board. Paints name roles; each app
// resolves them with `gameBoardColors` from ui-tokens.
import {
  HOME_COLUMN,
  LUDO_COLORS,
  START_INDEX,
  STAR_INDEXES,
  TRACK,
  YARD_ORIGIN,
  yardPoint,
  type LudoColor,
} from './board';

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
