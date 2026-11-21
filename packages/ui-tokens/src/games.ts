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

const LIGHT: GameBoardColors = {
  board: '#E6EAF0',
  cell: '#FFFFFF',
  line: '#C3CBD6',
  players: {
    red: { fill: '#E53935', ring: '#8E1B18', on: '#FFFFFF', soft: '#FBD9D7' },
    green: { fill: '#2FAA4E', ring: '#145C27', on: '#FFFFFF', soft: '#D3F0DB' },
    yellow: { fill: '#FFC21A', ring: '#765300', on: '#3A2900', soft: '#FFEDB8' },
    blue: { fill: '#1E88E5', ring: '#0B4682', on: '#FFFFFF', soft: '#D3E6FA' },
  },
};

const DARK: GameBoardColors = {
  board: '#0E1217',
  cell: '#1B2129',
  line: '#323C49',
  players: {
    red: { fill: '#F2504A', ring: '#FF9A94', on: '#2A0605', soft: '#3A1918' },
    green: { fill: '#3CC062', ring: '#8AE6A3', on: '#04210D', soft: '#16301E' },
    yellow: { fill: '#FFC93D', ring: '#FFE08A', on: '#2E2000', soft: '#3A3016' },
    blue: { fill: '#3D9BF0', ring: '#9CCBFF', on: '#03182E', soft: '#152A40' },
  },
};

/** The board and player colors for light or dark mode. */
export function gameBoardColors(dark: boolean): GameBoardColors {
  return dark ? DARK : LIGHT;
}
