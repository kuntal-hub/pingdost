// Any game with friends by its type (the engine's `GameRecord.gameType`): folded and summed up
// for chat cards and the Games tab, whichever game it is.
import { catalogEntry } from './core/catalog';
import type { Sha256 } from './core/fair-dice';
import type { GameEventLike, GamePlayerRef } from './core/net';
import { isTurnGameId, type AnyTurnRules, type TurnCore, type TurnGameId } from './core/turn';
import { turnGameSummary } from './core/turn-labels';
import { foldTurnGame, type TurnNetGame } from './core/turn-network';
import { ludoGameSummary, type GameSummary, type NameOf } from './ludo/labels';
import { foldLudoGame, type LudoNetGame } from './ludo/network';
import { turnRules } from './turn-games';

export type AnyNetGame =
  | { type: 'ludo'; game: LudoNetGame }
  | { type: TurnGameId; rules: AnyTurnRules; game: TurnNetGame<TurnCore, unknown, unknown> };

/** Whether this build can play a game type. */
export function isPlayableGameType(type: string): type is 'ludo' | TurnGameId {
  return type === 'ludo' || isTurnGameId(type);
}

/** The game's display name ("Connect Four"), or "Game" for a type this build doesn't know. */
export function gameTypeLabel(type: string): string {
  return isPlayableGameType(type) ? catalogEntry(type).name : 'Game';
}

export function foldAnyGame(
  type: string,
  gameId: string,
  events: readonly GameEventLike[],
  sha256: Sha256,
): AnyNetGame | null {
  if (type === 'ludo') return { type, game: foldLudoGame(gameId, events, sha256) };
  if (isTurnGameId(type)) {
    const rules = turnRules(type);
    return { type, rules, game: foldTurnGame(rules, gameId, events, sha256) };
  }
  return null;
}

const UNKNOWN: GameSummary = {
  state: 'invalid',
  text: 'Update PingDost to play',
  live: false,
  playing: false,
};

export function anyGameSummary(
  folded: AnyNetGame | null,
  self: GamePlayerRef,
  names?: NameOf,
): GameSummary {
  if (!folded) return UNKNOWN;
  if (folded.type === 'ludo') return ludoGameSummary(folded.game, self, names);
  return turnGameSummary(folded.rules, folded.game, self, names);
}

/** The table's size and the rules of a game, for a rematch with the same settings. */
export function rematchOf(folded: AnyNetGame): {
  type: 'ludo' | TurnGameId;
  maxPlayers: number;
  settings: unknown;
} {
  return { type: folded.type, maxPlayers: folded.game.maxPlayers, settings: folded.game.settings };
}
