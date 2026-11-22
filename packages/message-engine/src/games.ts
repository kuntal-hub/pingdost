/**
 * Games inside chats (ADR 0049): the engine stores and relays game events but does not
 * interpret them. `@pingdost/games` folds a game's events into its state.
 */
import { GameType, type Game } from '@pingdost/protocol';

import type { GameRecord } from './store';

/** The catalog ID of a wire game type (`@pingdost/games` uses the same IDs). */
export function gameTypeName(type: GameType): string {
  switch (type) {
    case GameType.LUDO:
      return 'ludo';
    case GameType.TIC_TAC_TOE:
      return 'tic-tac-toe';
    case GameType.CONNECT_FOUR:
      return 'connect-four';
    case GameType.DOTS_AND_BOXES:
      return 'dots-and-boxes';
    case GameType.SNAKES_AND_LADDERS:
      return 'snakes-and-ladders';
    case GameType.CHESS:
      return 'chess';
    default:
      return 'unknown';
  }
}

/** The JSON body of a `game` card message. */
export function gameCardBody(gameId: string, type: string): string {
  return JSON.stringify({ gameId, type });
}

/** Reads a `game` card's body; null if it is not one. */
export function readGameCard(body: string): { gameId: string; type: string } | null {
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const { gameId, type } = value as Record<string, unknown>;
    return typeof gameId === 'string' && typeof type === 'string' ? { gameId, type } : null;
  } catch {
    return null;
  }
}

/**
 * The game's index row after an event: created on its first event (which may overtake the
 * `create`), filled in by the `create`.
 */
export function nextGameRecord(
  existing: GameRecord | undefined,
  game: Game,
  event: { gameId: string; conversationId: string; senderUserId: string; sentAt: number },
  now: number,
): GameRecord {
  const record: GameRecord = existing
    ? { ...existing, updatedAt: Math.max(existing.updatedAt, now) }
    : {
        gameId: event.gameId,
        conversationId: event.conversationId,
        gameType: 'unknown',
        createdBy: '',
        createdAt: event.sentAt,
        updatedAt: now,
        seatSeed: null,
      };
  if (game.event.case === 'create') {
    record.gameType = gameTypeName(game.event.value.type);
    record.createdBy = event.senderUserId;
    record.createdAt = event.sentAt;
  }
  return record;
}
