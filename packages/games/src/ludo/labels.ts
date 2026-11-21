// Ludo's English UI text, shared by the phone and the web.
import { HOME, YARD, type LudoColor } from './board';
import type { LudoView } from './controller';
import { LUDO_TOKENS, type LudoSettings } from './rules';
import type { BotLevel, SeatKind } from '../core/types';

export const LUDO_COLOR_NAMES: Record<LudoColor, string> = {
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
};

export const BOT_LEVEL_NAMES: Record<BotLevel, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

export function ordinal(place: number): string {
  const suffix = place === 1 ? 'st' : place === 2 ? 'nd' : place === 3 ? 'rd' : 'th';
  return `${place}${suffix}`;
}

/** "You", or the color's name for anyone else. */
export function seatName(kind: SeatKind, color: LudoColor): string {
  return kind === 'you' ? 'You' : LUDO_COLOR_NAMES[color];
}

/** One line under the board: whose turn it is and what happens now. */
export function ludoStatus(view: LudoView): string {
  const { state, seats, you, waiting } = view;
  const player = state.players[state.current]!;
  const name = LUDO_COLOR_NAMES[player.color];
  const mine = state.current === you;
  switch (waiting) {
    case 'over': {
      const place = state.players[you]!.rank ?? state.players.length;
      return place === 1 ? 'You won!' : `You finished ${ordinal(place)}`;
    }
    case 'you-roll':
      return 'Your turn: roll the dice';
    case 'you-move':
      return 'Pick a piece to move';
    case 'rolling':
      return mine ? 'Rolling…' : `${name} is rolling…`;
    case 'moving':
      return mine ? 'Moving…' : `${name} is moving…`;
    case 'computer':
      return seats[state.current] === 'computer' ? `${name} is thinking…` : `${name}'s turn`;
  }
}

/** A note about the last roll when it did nothing, else null. */
export function ludoRollNote(view: LudoView): string | null {
  const roll = view.lastRoll;
  if (!roll || (view.lastMove && view.lastMove.id > roll.id)) return null;
  const who =
    roll.seat === view.you ? 'You' : LUDO_COLOR_NAMES[view.state.players[roll.seat]!.color];
  if (roll.outcome === 'pass') return `${who} rolled ${roll.die}: no piece can move`;
  if (roll.outcome === 'third-six') return `${who} rolled a third 6: turn over`;
  return null;
}

/** A piece for screen readers: "Red piece 2, 31 squares to go". */
export function pieceLabel(color: LudoColor, token: number, progress: number): string {
  const name = `${LUDO_COLOR_NAMES[color]} piece ${token + 1}`;
  if (progress === YARD) return `${name}, in the yard`;
  if (progress >= HOME) return `${name}, home`;
  const left = HOME - progress;
  return `${name}, ${left} ${left === 1 ? 'square' : 'squares'} to go`;
}

/** The rules in play, as short lines for a rules sheet. */
export function ludoRules(settings: LudoSettings): string[] {
  return [
    settings.needSix
      ? 'Roll a 6 to bring a piece out of the yard.'
      : 'Any roll brings a piece out of the yard.',
    'A 6, a capture or reaching home gives you another roll. A third 6 in a row ends your turn.',
    'Land on another color to send that piece back to its yard. Start squares and stars are safe.',
    settings.blockades
      ? 'Two of your pieces on one plain square form a wall: nobody else can pass or land on it.'
      : 'There are no walls: pieces pass each other freely.',
    'You need the exact roll to reach home.',
    settings.stopAtFirstWinner
      ? 'The game ends when the first player has every piece home.'
      : 'The first player home wins; the others play on for places.',
    `Each player has ${LUDO_TOKENS} pieces.`,
  ];
}
