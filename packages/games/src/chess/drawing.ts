// Chess pieces as shapes both apps draw (Phase 44): PingDost's own simple silhouettes on a 45 by
// 45 grid. `fill` shapes take the piece color with a dark edge; `line` shapes are strokes and
// `dot` shapes small fills in the detail color (light on black pieces, dark on white ones).
import { BISHOP, KING, KNIGHT, PAWN, QUEEN, ROOK } from './position';

export interface PieceShape {
  d: string;
  kind: 'fill' | 'line' | 'dot';
}

export const PIECE_BOX = 45;
export const PIECE_EDGE_WIDTH = 1.5;
export const PIECE_LINE_WIDTH = 1.3;

const PLINTH = 'M 10 39.5 Q 10 35.5 14 35.5 L 31 35.5 Q 35 35.5 35 39.5 Z';
const circle = (cx: number, cy: number, r: number) =>
  `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;

export const PIECE_SHAPES: Record<number, readonly PieceShape[]> = {
  [PAWN]: [
    { kind: 'fill', d: 'M 12 39.5 Q 12 35.5 16 35.5 L 29 35.5 Q 33 35.5 33 39.5 Z' },
    { kind: 'fill', d: 'M 19 22.5 L 26 22.5 Q 27 29 31.5 35.5 L 13.5 35.5 Q 18 29 19 22.5 Z' },
    {
      kind: 'fill',
      d: 'M 17 19.5 L 28 19.5 Q 29.5 19.5 29.5 21 Q 29.5 22.5 28 22.5 L 17 22.5 Q 15.5 22.5 15.5 21 Q 15.5 19.5 17 19.5 Z',
    },
    { kind: 'fill', d: circle(22.5, 13, 5.2) },
  ],
  [ROOK]: [
    { kind: 'fill', d: PLINTH },
    { kind: 'fill', d: 'M 14 35.5 L 15.5 19.5 L 29.5 19.5 L 31 35.5 Z' },
    { kind: 'fill', d: 'M 12.5 20 L 32.5 20 L 32.5 17 L 12.5 17 Z' },
    {
      kind: 'fill',
      d: 'M 12.5 17 L 12.5 9 L 17 9 L 17 12 L 20.5 12 L 20.5 9 L 24.5 9 L 24.5 12 L 28 12 L 28 9 L 32.5 9 L 32.5 17 Z',
    },
    { kind: 'line', d: 'M 16 31 L 29 31' },
  ],
  [KNIGHT]: [
    { kind: 'fill', d: PLINTH },
    {
      kind: 'fill',
      d: 'M 14 35.5 C 15.5 31 17.5 27 19 23.5 C 17 24.5 14.5 26.5 12 26.5 C 10 26.5 9 25 9.5 23 C 10 20.5 11.5 17.5 13.5 15 C 15 13 16.5 11.5 17.5 10.5 L 18.5 5.5 L 21 9 C 25 8.5 29.5 10 32 13.5 C 34.5 17 35.5 21.5 34.5 26 C 34 29.5 33 32.5 32 35.5 Z',
    },
    { kind: 'dot', d: circle(17.8, 14.6, 1.2) },
    { kind: 'dot', d: circle(11.4, 23.4, 0.8) },
    { kind: 'line', d: 'M 24 11.5 C 28 13 30.5 17 31 22' },
  ],
  [BISHOP]: [
    { kind: 'fill', d: PLINTH },
    {
      kind: 'fill',
      d: 'M 15.5 32.5 L 29.5 32.5 Q 31 32.5 31 34 Q 31 35.5 29.5 35.5 L 15.5 35.5 Q 14 35.5 14 34 Q 14 32.5 15.5 32.5 Z',
    },
    { kind: 'fill', d: 'M 15.5 32.5 Q 14.5 23.5 22.5 12.5 Q 30.5 23.5 29.5 32.5 Z' },
    { kind: 'fill', d: circle(22.5, 9.5, 2.6) },
    { kind: 'line', d: 'M 25.6 17.5 L 20.8 23.5' },
  ],
  [QUEEN]: [
    { kind: 'fill', d: PLINTH },
    {
      kind: 'fill',
      d: 'M 13.5 35.5 L 11 16.5 L 17 25.5 L 19.5 13 L 22.5 24.5 L 25.5 13 L 28 25.5 L 34 16.5 L 31.5 35.5 Z',
    },
    { kind: 'fill', d: circle(11, 14.5, 2.1) },
    { kind: 'fill', d: circle(19.5, 11, 2.1) },
    { kind: 'fill', d: circle(25.5, 11, 2.1) },
    { kind: 'fill', d: circle(34, 14.5, 2.1) },
    { kind: 'line', d: 'M 14.5 31 Q 22.5 29 30.5 31' },
  ],
  [KING]: [
    { kind: 'fill', d: PLINTH },
    {
      kind: 'fill',
      d: 'M 14 35.5 C 12 28 11 23.5 15 21 C 18.5 19 26.5 19 30 21 C 34 23.5 33 28 31 35.5 Z',
    },
    { kind: 'fill', d: 'M 17.5 21 C 18 17 20 15.5 22.5 15.5 C 25 15.5 27 17 27.5 21 Z' },
    {
      kind: 'fill',
      d: 'M 21.25 3.5 L 23.75 3.5 L 23.75 7 L 27 7 L 27 9.5 L 23.75 9.5 L 23.75 15.5 L 21.25 15.5 L 21.25 9.5 L 18 9.5 L 18 7 L 21.25 7 Z',
    },
    { kind: 'line', d: 'M 15 29.5 Q 22.5 27 30 29.5' },
  ],
};

export const PIECE_NAMES: Record<number, string> = {
  [PAWN]: 'pawn',
  [KNIGHT]: 'knight',
  [BISHOP]: 'bishop',
  [ROOK]: 'rook',
  [QUEEN]: 'queen',
  [KING]: 'king',
};
