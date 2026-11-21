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
};

/** The board and player colors for light or dark mode. */
export function gameBoardColors(dark: boolean): GameBoardColors {
  return dark ? DARK : LIGHT;
}
