// English UI text for the turn games, shared by the phone and the web.
import type { GamePlayerRef } from './net';
import type { AnyTurnRules, TurnCore } from './turn';
import type { TurnView } from './turn-controller';
import type { TurnNetView } from './turn-net-controller';
import { turnSeatOf, type TurnNetGame } from './turn-network';
import { ordinal, type GameSummary, type NameOf } from '../ludo/labels';

/** Everyone still in shares first place. */
export function isDraw(state: TurnCore): boolean {
  if (!state.ranks) return false;
  const active = state.left.flatMap((left, seat) => (left ? [] : [seat]));
  return active.length > 1 && active.every((seat) => state.ranks![seat] === 1);
}

export interface TurnStanding {
  seat: number;
  rank: number;
  left: boolean;
}

/** Seats best first, for a result card. */
export function turnStandings(state: TurnCore): TurnStanding[] {
  const ranks = state.ranks ?? state.left.map(() => state.seats);
  return ranks
    .map((rank, seat) => ({ seat, rank, left: state.left[seat]! }))
    .sort((a, b) => a.rank - b.rank || a.seat - b.seat);
}

/** "You won!", "It's a draw", "You finished 2nd", from one seat's side. */
export function turnResultLine(
  state: TurnCore,
  you: number,
  names: (seat: number) => string,
): string {
  if (!state.ranks) return '';
  if (isDraw(state)) return state.left[you] ? 'Draw' : "It's a draw";
  if (you >= 0) {
    if (state.left[you]) return 'You left the game';
    const place = state.ranks[you]!;
    if (place === 1) return 'You won!';
    const active = state.left.filter((left) => !left).length;
    return active <= 2 && state.seats === 2 ? 'You lost' : `You finished ${ordinal(place)}`;
  }
  const winner = state.ranks.findIndex((rank, seat) => rank === 1 && !state.left[seat]);
  return winner >= 0 ? `${names(winner)} won` : 'Game over';
}

/** One line under the board in a solo game. */
export function turnSoloStatus(rules: AnyTurnRules, view: TurnView<TurnCore, unknown>): string {
  const { state, you, waiting } = view;
  const name = (seat: number) => (seat === you ? 'You' : rules.sideName(state, seat));
  const mine = state.current === you;
  switch (waiting) {
    case 'over':
      return turnResultLine(state, you, name);
    case 'you':
      return rules.dice ? 'Your turn: roll the die' : 'Your turn';
    case 'rolling':
      return mine ? 'Rolling…' : `${name(state.current)} is rolling…`;
    case 'moving': {
      const seat = view.last?.seat ?? state.current;
      return seat === you ? 'Your move' : `${name(seat)} played`;
    }
    case 'them':
      return `${name(state.current)} is thinking…`;
  }
}

function netName(
  rules: AnyTurnRules,
  game: TurnNetGame<TurnCore, unknown, unknown>,
  state: TurnCore,
  seat: number,
  you: number,
  names?: NameOf,
): string {
  if (seat === you) return 'You';
  const info = game.seats[seat];
  return (info && names?.(info.userId)) ?? rules.sideName(state, seat);
}

/** One line under the board in a game with friends. */
export function turnNetStatus(
  rules: AnyTurnRules,
  view: TurnNetView<TurnCore, unknown, unknown>,
  names?: NameOf,
): string {
  const { game, state, you } = view;
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
  if (!state) return '';
  const name = (seat: number) => netName(rules, game, state, seat, you, names);
  if (view.waiting === 'over' || state.ranks) return turnResultLine(state, you, name);
  const mine = state.current === you;
  switch (view.waiting) {
    case 'you':
      return rules.dice ? 'Your turn: roll the die' : 'Your turn';
    case 'rolling':
      return mine ? 'Rolling…' : `${name(state.current)} is rolling…`;
    case 'moving': {
      const seat = view.last?.seat ?? state.current;
      return seat === you ? 'Your move' : `${name(seat)} played`;
    }
    default:
      return mine ? 'Your turn' : `${name(state.current)}'s turn`;
  }
}

/** A turn game with friends in one line, from this device's side (chat card, Games tab). */
export function turnGameSummary(
  rules: AnyTurnRules,
  game: TurnNetGame<TurnCore, unknown, unknown>,
  self: GamePlayerRef,
  names?: NameOf,
): GameSummary {
  const seat = turnSeatOf(game, self);
  const inLobby = game.lobby.some((e) => e.userId === self.userId);
  switch (game.phase) {
    case 'missing':
      return { state: 'missing', text: 'Loading…', live: false, playing: false };
    case 'invalid':
      return { state: 'invalid', text: "Can't be played", live: false, playing: false };
    case 'ended':
      return { state: 'ended', text: 'Ended', live: false, playing: inLobby };
    case 'lobby': {
      const count = `${game.lobby.length}/${game.maxPlayers}`;
      if (inLobby) {
        return {
          state: 'joined',
          text: `Waiting for players · ${count}`,
          live: true,
          playing: true,
        };
      }
      if (game.lobby.length >= game.maxPlayers) {
        return { state: 'full', text: `Full · ${count}`, live: true, playing: false };
      }
      return { state: 'invite', text: `Join · ${count} players`, live: true, playing: false };
    }
    case 'over': {
      const state = game.state!;
      const name = (s: number) => netName(rules, game, state, s, seat, names);
      const text = turnResultLine(state, seat, name).replace(/!$/, '');
      return { state: 'over', text, live: false, playing: seat >= 0 };
    }
    default: {
      const state = game.state!;
      if (seat >= 0 && state.current === seat) {
        return { state: 'your-turn', text: 'Your turn', live: true, playing: true };
      }
      return {
        state: 'their-turn',
        text: `${netName(rules, game, state, state.current, seat, names)}'s turn`,
        live: true,
        playing: seat >= 0 && !state.left[seat],
      };
    }
  }
}
