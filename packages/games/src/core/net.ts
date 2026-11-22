// What every game with friends shares (ADR 0049): stored events decoded and ordered, the
// lobby (the host's `create`, then one `join` per person, then the host's `start`), the host's
// `end`, and emotes. Each game folds its own turns on top (`ludo/network.ts`, `turn-network.ts`).
import { decodeGame, fromBase64, type Game, type GameCreate } from '@pingdost/protocol';

/** A stored game event (the engine's `GameEventRecord` has this shape). */
export interface GameEventLike {
  eventId: string;
  gameId: string;
  senderUserId: string;
  senderDeviceId: string;
  sentAt: number;
  receivedAt: number;
  /** The `Game` message, protobuf in base64. */
  payload: string;
}

export interface GamePlayerRef {
  userId: string;
  deviceId: string;
}

export interface DecodedGameEvent extends GamePlayerRef {
  eventId: string;
  sentAt: number;
  receivedAt: number;
  game: Game;
}

export interface LobbyEntry extends GamePlayerRef {
  eventId: string;
  anchor: Uint8Array;
  salt: Uint8Array;
  /** Hidden-hand games (ADR 0052): what the seat committed to; empty otherwise. */
  data: Uint8Array;
}

export interface NetEmote extends GamePlayerRef {
  eventId: string;
  emoji: string;
  receivedAt: number;
}

export const samePlayer = (a: GamePlayerRef, b: GamePlayerRef): boolean =>
  a.userId === b.userId && a.deviceId === b.deviceId;

/** Decodes a game's events, drops duplicates and malformed ones, and orders them by event ID. */
export function decodeGameEvents(events: readonly GameEventLike[]): DecodedGameEvent[] {
  const seen = new Set<string>();
  const out: DecodedGameEvent[] = [];
  for (const e of events) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    try {
      out.push({
        eventId: e.eventId,
        userId: e.senderUserId,
        deviceId: e.senderDeviceId,
        sentAt: e.sentAt,
        receivedAt: e.receivedAt,
        game: decodeGame(fromBase64(e.payload)),
      });
    } catch {
      // A malformed event never counts.
    }
  }
  return out.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}

export function gameEmotes(all: readonly DecodedGameEvent[]): NetEmote[] {
  return all.flatMap((e) =>
    e.game.event.case === 'emote'
      ? [
          {
            eventId: e.eventId,
            userId: e.userId,
            deviceId: e.deviceId,
            emoji: e.game.event.value.emoji,
            receivedAt: e.receivedAt,
          },
        ]
      : [],
  );
}

export interface LobbyFold {
  create: DecodedGameEvent;
  /** The `create` body. */
  body: GameCreate;
  host: GamePlayerRef;
  /** The host's `end`, if any: events with a higher ID are ignored. */
  end: DecodedGameEvent | undefined;
  /** The events up to the end. */
  live: DecodedGameEvent[];
  /** The host's `start`, if any. */
  start: DecodedGameEvent | undefined;
  /**
   * The host first, then everyone who joined, oldest first (may be more than fit). Before the
   * start, people who left again are taken out.
   */
  lobby: LobbyEntry[];
  /** Before the start: the host left the lobby (the game is over). */
  hostLeft: boolean;
}

/** The lobby part of a game's events, or null while the `create` has not arrived. */
export function foldLobby(gameId: string, all: readonly DecodedGameEvent[]): LobbyFold | null {
  const create = all.find((e) => e.eventId === gameId && e.game.event.case === 'create');
  if (!create || create.game.event.case !== 'create') return null;
  const body = create.game.event.value;
  const host: GamePlayerRef = { userId: create.userId, deviceId: create.deviceId };
  const isHost = (e: DecodedGameEvent) => samePlayer(e, host);
  const end = all.find((e) => e.game.event.case === 'end' && isHost(e));
  const cutoff = end?.eventId;
  const live = cutoff === undefined ? [...all] : all.filter((e) => e.eventId <= cutoff);

  const lobby: LobbyEntry[] = [
    { ...host, eventId: create.eventId, anchor: body.anchor, salt: body.salt, data: body.seatData },
  ];
  for (const e of live) {
    if (e.game.event.case !== 'join') continue;
    if (lobby.some((entry) => entry.userId === e.userId || entry.deviceId === e.deviceId)) continue;
    lobby.push({
      userId: e.userId,
      deviceId: e.deviceId,
      eventId: e.eventId,
      anchor: e.game.event.value.anchor,
      salt: e.game.event.value.salt,
      data: e.game.event.value.seatData,
    });
  }
  const start = live.find((e) => e.game.event.case === 'start' && isHost(e));
  if (start) return { create, body, host, end, live, start, lobby, hostLeft: false };
  const left = (entry: LobbyEntry) =>
    live.some(
      (e) => e.game.event.case === 'leave' && samePlayer(e, entry) && e.eventId > entry.eventId,
    );
  return {
    create,
    body,
    host,
    end,
    live,
    start: undefined,
    lobby: lobby.filter((entry, i) => i === 0 || !left(entry)),
    hostLeft: left(lobby[0]!),
  };
}
