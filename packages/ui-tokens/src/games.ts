// Board-game colors (ADR 0049). Like avatars, players keep their color whatever scheme is on,
// so "you are yellow" means the same on every screen. Only light and dark differ.

/** Player colors in turn order (clockwise from the bottom left, as in Ludo). */
export const gamePlayerColors = ['red', 'green', 'yellow', 'blue'] as const;
export type GamePlayerColor = (typeof gamePlayerColors)[number];

/** A second cue next to the color, for color-blind players: drawn on every piece and base. */
export const gamePlayerShapes: Record<
  GamePlayerColor,
  'circle' | 'square' | 'triangle' | 'diamond'
> = {
  red: 'circle',
  green: 'square',
  yellow: 'triangle',
  blue: 'diamond',
};

export interface GamePlayerLook {
  /** The piece and the colored squares of the board. */
  fill: string;
  /** The lit side of a piece or die (gradients, ADR 0050). */
  light: string;
  /** The shaded side of a piece or die. */
  dark: string;
  /** The piece's edge: readable (3:1) on board cells and on the app's surfaces. */
  ring: string;
  /** The shape glyph drawn on `fill`. */
  on: string;
  /** The tinted yard (base) behind waiting pieces. */
  soft: string;
}

export interface GameBoardColors {
  /** Behind the cells. */
  board: string;
  /** A plain track cell. */
  cell: string;
  /** Cell borders and the star outlines. */
  line: string;
  players: Record<GamePlayerColor, GamePlayerLook>;
  /** Phase 43: the second cell color of a checkered board (Snakes and Ladders). */
  cellAlt: string;
  /** Square numbers and other small text on cells (4.5:1 on both cell colors). */
  label: string;
  /** The Connect Four frame around the holes (the holes show `board`). */
  frame: string;
  /** Ladders, readable on both cell colors. */
  ladder: string;
  /** Snakes, each readable on both cell colors. */
  snakes: readonly [string, string, string];
  /** Dots and Boxes: the dots, and lines not drawn yet (hints). */
  dot: string;
  /** Phase 44. */
  chess: ChessColors;
  /** Phase 45: playing cards (the same in light and dark, like real cards). */
  cards: CardColors;
}

export interface CardColors {
  /** The back of a card, and the ring drawn on it. */
  back: string;
  pattern: string;
  /** The white edge around every card. */
  edge: string;
  /** A wild card's face. */
  wild: string;
  /** The lighter disc in the middle of a face. */
  shine: string;
}

const CARDS: CardColors = {
  back: '#273041',
  pattern: '#5B6B86',
  edge: '#F4F6FA',
  wild: '#1B1F27',
  shine: 'rgba(255, 255, 255, 0.22)',
};

export interface ChessPieceLook {
  fill: string;
  /** The outline: readable (3:1) on both square colors. */
  edge: string;
  /** Inner lines and the eye. */
  detail: string;
}

export interface ChessColors {
  light: string;
  dark: string;
  /** File and rank letters on the board's edge (4.5:1 on both square colors). */
  coord: string;
  /** Tints over a square (with alpha): the last move, the picked piece, a legal target, check. */
  lastMove: string;
  selected: string;
  hint: string;
  check: string;
  white: ChessPieceLook;
  black: ChessPieceLook;
}

// Vivid, Ludo-style colors (the user's list, ADR 0050).
const LIGHT: GameBoardColors = {
  board: '#E7EDF5',
  cell: '#FFFFFF',
  line: '#C2CCD9',
  players: {
    red: {
      fill: '#EF2B2D',
      light: '#FF7B6E',
      dark: '#A3131A',
      ring: '#8A1015',
      on: '#FFFFFF',
      soft: '#FFD6D3',
    },
    green: {
      fill: '#12A84A',
      light: '#5EE08C',
      dark: '#0A6B2E',
      ring: '#0B5A26',
      on: '#FFFFFF',
      soft: '#CDF3DA',
    },
    yellow: {
      fill: '#FFC20E',
      light: '#FFE477',
      dark: '#C78A00',
      ring: '#7A5400',
      on: '#3A2900',
      soft: '#FFF0B3',
    },
    blue: {
      fill: '#1877F2',
      light: '#6FB2FF',
      dark: '#0B4AA8',
      ring: '#0A3F8F',
      on: '#FFFFFF',
      soft: '#D2E5FF',
    },
  },
  cellAlt: '#EEF3FA',
  label: '#5B6778',
  frame: '#2457D6',
  ladder: '#93520F',
  snakes: ['#0B8A5F', '#8B3FD9', '#D44A12'],
  dot: '#334155',
  chess: {
    light: '#E8EDF5',
    dark: '#8FA4C4',
    coord: '#1D2A40',
    lastMove: 'rgba(246, 205, 70, 0.55)',
    selected: 'rgba(52, 120, 246, 0.42)',
    hint: 'rgba(15, 23, 42, 0.32)',
    check: 'rgba(239, 43, 45, 0.7)',
    white: { fill: '#FFFFFF', edge: '#1F2329', detail: '#1F2329' },
    black: { fill: '#2A2F37', edge: '#0E1013', detail: '#E8EDF5' },
  },
  cards: CARDS,
};

const DARK: GameBoardColors = {
  board: '#0D1117',
  cell: '#1A2029',
  line: '#313B48',
  players: {
    red: {
      fill: '#FF4545',
      light: '#FF8F85',
      dark: '#B3161C',
      ring: '#FF9A94',
      on: '#2A0605',
      soft: '#3D1A1B',
    },
    green: {
      fill: '#22C55E',
      light: '#7CF0A6',
      dark: '#11803A',
      ring: '#8AE6A3',
      on: '#04210D',
      soft: '#15331F',
    },
    yellow: {
      fill: '#FFCB2E',
      light: '#FFE58A',
      dark: '#C99300',
      ring: '#FFE08A',
      on: '#2E2000',
      soft: '#3B3115',
    },
    blue: {
      fill: '#3B8BFF',
      light: '#8EC2FF',
      dark: '#1557C0',
      ring: '#9CCBFF',
      on: '#03182E',
      soft: '#142B47',
    },
  },
  cellAlt: '#232B37',
  label: '#9AA7B8',
  frame: '#3A64C8',
  ladder: '#E0A458',
  snakes: ['#34D399', '#C084FC', '#FB923C'],
  dot: '#CBD5E1',
  chess: {
    light: '#C3CDDC',
    dark: '#7A90B2',
    coord: '#121926',
    lastMove: 'rgba(246, 205, 70, 0.5)',
    selected: 'rgba(80, 145, 255, 0.45)',
    hint: 'rgba(8, 12, 20, 0.36)',
    check: 'rgba(255, 69, 69, 0.75)',
    white: { fill: '#FFFFFF', edge: '#1F2329', detail: '#1F2329' },
    black: { fill: '#2A2F37', edge: '#0E1013', detail: '#E8EDF5' },
  },
  cards: CARDS,
};

/** The board and player colors for light or dark mode. */
export function gameBoardColors(dark: boolean): GameBoardColors {
  return dark ? DARK : LIGHT;
}
