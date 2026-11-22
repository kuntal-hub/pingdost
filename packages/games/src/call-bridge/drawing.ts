// Suit shapes both apps draw (Phase 46), on a 20 × 20 grid: no font glyphs (♠ ♥ ♦ ♣ fall back to
// color emoji on some phones). Spades, hearts, diamonds, clubs, in card-code order.

export const SUIT_BOX = 20;

export const SUIT_PATHS: readonly string[] = [
  // Spade
  'M10 2 C15 7 18 10 16.2 13 C14.8 15.2 12.3 14.8 11.2 13.2 C11.6 15.3 12.6 16.8 14 18 L6 18 C7.4 16.8 8.4 15.3 8.8 13.2 C7.7 14.8 5.2 15.2 3.8 13 C2 10 5 7 10 2 Z',
  // Heart
  'M10 17.5 C3.2 12.6 1 8.6 3.6 5.4 C5.6 3 8.7 3.6 10 6 C11.3 3.6 14.4 3 16.4 5.4 C19 8.6 16.8 12.6 10 17.5 Z',
  // Diamond
  'M10 1.8 L17 10 L10 18.2 L3 10 Z',
  // Club: three leaves and a stem
  'M10 2.4 A3.4 3.4 0 1 1 9.99 2.4 Z M5.6 8.2 A3.4 3.4 0 1 1 5.59 8.2 Z M14.4 8.2 A3.4 3.4 0 1 1 14.39 8.2 Z M9 11 L8.2 18 L11.8 18 L11 11 Z',
];

/** Hearts and diamonds are red. */
export const isRedSuit = (suit: number) => suit === 1 || suit === 2;
