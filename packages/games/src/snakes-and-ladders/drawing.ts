// The finishing square's trophy (PingDost's own shape, in a 24-unit box), so both apps draw the
// same goal on square 100. Ink is ui-tokens `gameBoardColors().goalInk`, on `goal`.
export const SNAKES_TROPHY = {
  /** Filled: the cup, the stem and the base. */
  fill: 'M7 3h10v6a5 5 0 0 1-10 0z M11 13.6h2V17h-2z M7.5 17h9a1 1 0 0 1 1 1v2h-11v-2a1 1 0 0 1 1-1z',
  /** Stroked with round caps and joins: the two handles. */
  handles: 'M7 5H4.8a2.4 2.4 0 0 0 0 4.8h2.6 M17 5h2.2a2.4 2.4 0 0 1 0 4.8h-2.6',
  handleWidth: 1.8,
  /** The box the paths are drawn in. */
  box: 24,
} as const;

/**
 * Where the goal's trophy and number sit, as shares of a cell: the trophy's box (left, top,
 * size), the number's center line and baseline, its font size, and the frame's inset and width.
 * Square 100 is the board's top left corner: the apps round the frame's corners by the board's
 * corner radius less the inset, so the frame follows the board's clipped corner.
 */
export const SNAKES_GOAL_LAYOUT = {
  trophy: { x: 0.27, y: 0.14, size: 0.46 },
  number: { x: 0.5, y: 0.84, size: 0.24 },
  frame: { inset: 0.06, width: 0.04 },
} as const;
