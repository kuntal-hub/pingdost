// The games the Games screen lists (ADR 0049). Only `available` ones can be started; the rest
// show what is coming. Names are English UI labels; each app draws its own icon for `icon`.
import type { GameId } from './types';

export interface CatalogEntry {
  id: GameId;
  name: string;
  /** One line under the name. */
  tagline: string;
  minPlayers: number;
  maxPlayers: number;
  /** An icon key the apps map to a Lucide icon. */
  icon: 'dice' | 'grid' | 'circles' | 'dots' | 'ladder' | 'chess' | 'cards' | 'spade' | 'chips';
  available: boolean;
}

export const GAME_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'ludo',
    name: 'Ludo',
    tagline: 'Race your pieces home. Roll a 6 to start.',
    minPlayers: 2,
    maxPlayers: 4,
    icon: 'dice',
    available: true,
  },
  {
    id: 'tic-tac-toe',
    name: 'Tic-Tac-Toe',
    tagline: 'Three in a row wins.',
    minPlayers: 2,
    maxPlayers: 2,
    icon: 'grid',
    available: true,
  },
  {
    id: 'connect-four',
    name: 'Connect Four',
    tagline: 'Drop discs, line up four.',
    minPlayers: 2,
    maxPlayers: 2,
    icon: 'circles',
    available: true,
  },
  {
    id: 'dots-and-boxes',
    name: 'Dots and Boxes',
    tagline: 'Close the most boxes.',
    minPlayers: 2,
    maxPlayers: 4,
    icon: 'dots',
    available: true,
  },
  {
    id: 'snakes-and-ladders',
    name: 'Snakes and Ladders',
    tagline: 'Climb up, slide down.',
    minPlayers: 2,
    maxPlayers: 4,
    icon: 'ladder',
    available: true,
  },
  {
    id: 'chess',
    name: 'Chess',
    tagline: 'The classic, with a friend or the computer.',
    minPlayers: 2,
    maxPlayers: 2,
    icon: 'chess',
    available: true,
  },
  {
    id: 'last-card',
    name: 'Last Card',
    tagline: 'Match the color or the number, empty your hand first.',
    minPlayers: 2,
    maxPlayers: 4,
    icon: 'cards',
    available: true,
  },
  {
    id: 'call-bridge',
    name: 'Call Bridge',
    tagline: 'Call your tricks, spades are trumps.',
    minPlayers: 4,
    maxPlayers: 4,
    icon: 'spade',
    available: false,
  },
  {
    id: 'poker',
    name: 'Poker',
    tagline: "Texas Hold'em with play chips.",
    minPlayers: 2,
    maxPlayers: 6,
    icon: 'chips',
    available: false,
  },
];

export function catalogEntry(id: GameId): CatalogEntry {
  return GAME_CATALOG.find((entry) => entry.id === id)!;
}
