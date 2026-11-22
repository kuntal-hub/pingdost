// Ludo's English UI text, shared by the phone and the web.
import { HOME, YARD, type LudoColor } from './board';
import type { LudoView } from './controller';
import { ludoSeatOf, type LudoNetGame } from './network';
import type { LudoNetView } from './network-controller';
import { LUDO_TOKENS, type LudoSettings } from './rules';
import type { GamePlayerRef } from '../core/net';
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

/** How the apps name people: a contact name, or null to fall back to the color. */
export type NameOf = (userId: string) => string | null;

function netSeatName(view: LudoNetView, seat: number, names?: NameOf): string {
  if (seat === view.you) return 'You';
  const info = view.game.seats[seat];
  if (!info) return 'Someone';
  return names?.(info.userId) ?? LUDO_COLOR_NAMES[info.color];
}

/** One line under the board in a game with friends. */
export function ludoNetStatus(view: LudoNetView, names?: NameOf): string {
  const { game, board, you } = view;
  switch (game.phase) {
    case 'missing':
      return 'Loading the game…';
    case 'invalid':
      return "This game can't be played";
    case 'lobby':
      return `Waiting for players (${game.lobby.length}/${game.maxPlayers})`;
    case 'ended':
      return 'The host ended the game';
    default:
      break;
  }
  if (!board) return '';
  const state = board.state;
  if (board.waiting === 'over' || state.phase === 'over') {
    if (you >= 0) {
      const place = state.players[you]!.rank;
      if (place === 1) return 'You won!';
      return place ? `You finished ${ordinal(place)}` : 'You left the game';
    }
    const winner = state.players.findIndex((p) => p.rank === 1);
    return winner >= 0 ? `${netSeatName(view, winner, names)} won` : 'Game over';
  }
  const name = netSeatName(view, state.current, names);
  switch (board.waiting) {
    case 'you-roll':
      return 'Your turn: roll the dice';
    case 'you-move':
      return 'Pick a piece to move';
    case 'rolling':
      return state.current === you ? 'Rolling…' : `${name} is rolling…`;
    case 'moving':
      return state.current === you ? 'Moving…' : `${name} is moving…`;
    default:
      return state.current === you ? 'Your turn' : `${name}'s turn`;
  }
}

export type GameSummaryState =
  | 'missing'
  | 'invite'
  | 'joined'
  | 'full'
  | 'your-turn'
  | 'their-turn'
  | 'over'
  | 'ended'
  | 'invalid';

export interface GameSummary {
  state: GameSummaryState;
  /** One line for the chat card and the Games tab. */
  text: string;
  /** Still going (lobby or play). */
  live: boolean;
  /** This device has a seat, or joined the lobby. */
  playing: boolean;
}

/** A game with friends in one line, from this device's side. */
export function ludoGameSummary(
  game: LudoNetGame,
  self: GamePlayerRef,
  names?: NameOf,
): GameSummary {
  const seat = ludoSeatOf(game, self);
  const inLobby = game.lobby.some((e) => e.userId === self.userId);
  const nameOf = (index: number) => {
    const info = game.seats[index];
    if (index === seat) return 'You';
    return info ? (names?.(info.userId) ?? LUDO_COLOR_NAMES[info.color]) : 'Someone';
  };
  switch (game.phase) {
    case 'missing':
      return { state: 'missing', text: 'Loading…', live: false, playing: false };
    case 'invalid':
      return { state: 'invalid', text: "Can't be played", live: false, playing: false };
    case 'ended':
      return { state: 'ended', text: 'Ended', live: false, playing: inLobby };
    case 'lobby': {
      const count = `${game.lobby.length}/${game.maxPlayers}`;
      if (inLobby)
        return {
          state: 'joined',
          text: `Waiting for players · ${count}`,
          live: true,
          playing: true,
        };
      if (game.lobby.length >= game.maxPlayers) {
        return { state: 'full', text: `Full · ${count}`, live: true, playing: false };
      }
      return { state: 'invite', text: `Join · ${count} players`, live: true, playing: false };
    }
    case 'over': {
      const state = game.state!;
      if (seat >= 0) {
        const place = state.players[seat]!.rank;
        const text =
          place === 1 ? 'You won' : place ? `You finished ${ordinal(place)}` : 'You left';
        return { state: 'over', text, live: false, playing: true };
      }
      const winner = state.players.findIndex((p) => p.rank === 1);
      return {
        state: 'over',
        text: winner >= 0 ? `${nameOf(winner)} won` : 'Game over',
        live: false,
        playing: false,
      };
    }
    default: {
      const state = game.state!;
      if (seat >= 0 && state.current === seat) {
        return { state: 'your-turn', text: 'Your turn', live: true, playing: true };
      }
      return {
        state: 'their-turn',
        text: `${nameOf(state.current)}'s turn`,
        live: true,
        playing: seat >= 0 && !state.players[seat]!.left,
      };
    }
  }
}
