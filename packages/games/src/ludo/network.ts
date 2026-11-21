// Ludo with friends (ADR 0049): every device folds the same set of E2EE game events into the
// same game, whatever order they arrived in. The fold is a pure function of the set: it starts
// over on every new event, so devices that saw events in different orders still agree once they
// have the same events.
// - Lobby: the host's `create`, then `join`s (one seat per person, bound to the joining device),
//   then the host's `start`, which fixes the seats and their chain anchors.
// - Play: each step of a turn is a slot (`turn`, `index`). The seat to play fills it with a roll
//   or a move; after its timer anyone else seated may fill a roll slot with a skip or a move slot
//   with the move the computer would make (a proxy move). If a slot has several candidates, the
//   lowest event ID wins (receivers cannot check anyone's clock).
// - Three skips in a row and the player is out. A leave takes effect at the leaver's next slot.
//   The host's `end` stops the game for everyone; later events are ignored.
// - Dice: `fair-dice.ts`. Moves and skips carry the resulting state's hash, so a desync shows.
import { bytesToUuid, decodeGame, fromBase64, GameType, type Game } from '@pingdost/protocol';

import { LUDO_COLORS, type LudoColor } from './board';
import { chooseLudoToken } from './bot';
import {
  DEFAULT_LUDO_SETTINGS,
  leave,
  legalTokens,
  move,
  roll,
  setupLudo,
  skipTurn,
  type LudoSettings,
  type LudoState,
  type MoveResult,
  type RollResult,
} from './rules';
import {
  firstSeat,
  isNextReveal,
  rollDie,
  sameBytes,
  stateHash,
  type Sha256,
} from '../core/fair-dice';
import { seededRandom } from '../core/random';

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

export interface LudoLobbyEntry extends GamePlayerRef {
  eventId: string;
  anchor: Uint8Array;
  salt: Uint8Array;
}

export interface LudoNetSeat extends GamePlayerRef {
  color: LudoColor;
  anchor: Uint8Array;
  salt: Uint8Array;
}

export type LudoNetEntryKind = 'roll' | 'move' | 'proxy' | 'skip' | 'leave';

/** One applied step, with the state after it. */
export interface LudoNetEntry {
  eventId: string;
  kind: LudoNetEntryKind;
  /** The seat whose turn it was. */
  seat: number;
  by: GamePlayerRef;
  receivedAt: number;
  state: LudoState;
  roll?: RollResult;
  move?: MoveResult;
}

export interface LudoEmote extends GamePlayerRef {
  eventId: string;
  emoji: string;
  receivedAt: number;
}

/**
 * `missing`: the `create` has not arrived. `invalid`: the game cannot be played (a bad start).
 * `ended`: the host ended it before anyone won.
 */
export type LudoNetPhase = 'missing' | 'lobby' | 'playing' | 'over' | 'ended' | 'invalid';

export interface LudoNetGame {
  gameId: string;
  phase: LudoNetPhase;
  host: GamePlayerRef | null;
  maxPlayers: number;
  settings: LudoSettings;
  createdAt: number;
  /** The host first, then everyone who joined, oldest first (may be more than fit). */
  lobby: LudoLobbyEntry[];
  /** After the start, in turn order (clockwise by color): `seats[i]` plays `state.players[i]`. */
  seats: LudoNetSeat[];
  /** The state at the start, and now. */
  initial: LudoState | null;
  state: LudoState | null;
  entries: LudoNetEntry[];
  /** When the open slot opened here (receive time): its timer runs from this. */
  since: number;
  /** The open slot. */
  turn: number;
  index: number;
  /** Skips in a row, per seat. */
  strikes: number[];
  /** Roll events per seat whose secrets chain, applied or not: the next uses secret `rolls + 1`. */
  rolls: number[];
  /** A move or skip's state hash differed from ours. */
  desync: boolean;
  invalid: string | null;
  emotes: LudoEmote[];
}

/** Each step's timer (the user's choice: 30 s fixed). */
export const LUDO_TURN_MS = 30_000;
/** Others wait this much longer before they skip or move for an absent player. */
export const LUDO_GRACE_MS = 10_000;
/** Skips in a row that take a player out. */
export const LUDO_MAX_STRIKES = 3;

/** The state as one string for its hash: every field that matters, in a fixed order. */
export function canonicalLudo(state: LudoState): string {
  const players = state.players
    .map((p) => `${p.color}:${p.tokens.join(',')}:${p.rank ?? '-'}:${p.left ? 1 : 0}`)
    .join(';');
  return `${state.current}|${state.phase}|${state.die ?? '-'}|${state.sixes}|${state.turns}|${players}`;
}

export function ludoStateHash(sha256: Sha256, state: LudoState): Uint8Array {
  return stateHash(sha256, canonicalLudo(state));
}

/** The piece a proxy move must move: the Medium computer's choice, seeded by the state. */
export function proxyLudoToken(sha256: Sha256, state: LudoState): number {
  const hash = ludoStateHash(sha256, state);
  const seed = ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0;
  return chooseLudoToken(state, 'medium', seededRandom(seed));
}

/** A skip of the current seat: its turn ends, and the third in a row takes it out. */
export function applyLudoSkip(state: LudoState, strikes: number): LudoState {
  const seat = state.current;
  const skipped = skipTurn(state);
  return strikes + 1 >= LUDO_MAX_STRIKES ? leave(skipped, seat) : skipped;
}

export function ludoSettingsFromWire(game: Game): LudoSettings {
  if (game.event.case !== 'create' || game.event.value.settings.case !== 'ludo') {
    return DEFAULT_LUDO_SETTINGS;
  }
  const wire = game.event.value.settings.value;
  return {
    needSix: !wire.anyRollStarts,
    blockades: wire.blockades,
    stopAtFirstWinner: wire.stopAtFirstWinner,
  };
}

interface Decoded {
  eventId: string;
  userId: string;
  deviceId: string;
  sentAt: number;
  receivedAt: number;
  game: Game;
}

function decodeAll(events: readonly GameEventLike[]): Decoded[] {
  const seen = new Set<string>();
  const out: Decoded[] = [];
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

const same = (a: GamePlayerRef, b: GamePlayerRef) =>
  a.userId === b.userId && a.deviceId === b.deviceId;

function emptyGame(gameId: string): LudoNetGame {
  return {
    gameId,
    phase: 'missing',
    host: null,
    maxPlayers: 4,
    settings: DEFAULT_LUDO_SETTINGS,
    createdAt: 0,
    lobby: [],
    seats: [],
    initial: null,
    state: null,
    entries: [],
    since: 0,
    turn: 0,
    index: 0,
    strikes: [],
    rolls: [],
    desync: false,
    invalid: null,
    emotes: [],
  };
}

/** Folds a game's events (any order, duplicates allowed) into the game. */
export function foldLudoGame(
  gameId: string,
  events: readonly GameEventLike[],
  sha256: Sha256,
): LudoNetGame {
  const all = decodeAll(events);
  const game = emptyGame(gameId);
  game.emotes = all.flatMap((e) =>
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

  const create = all.find((e) => e.eventId === gameId && e.game.event.case === 'create');
  if (!create || create.game.event.case !== 'create') return game;
  if (create.game.event.value.type !== GameType.LUDO) {
    return { ...game, phase: 'invalid', invalid: 'not a Ludo game' };
  }
  const host: GamePlayerRef = { userId: create.userId, deviceId: create.deviceId };
  game.host = host;
  game.maxPlayers = create.game.event.value.maxPlayers;
  game.settings = ludoSettingsFromWire(create.game);
  game.createdAt = create.sentAt;
  const isHost = (e: Decoded) => same(e, host);
  const end = all.find((e) => e.game.event.case === 'end' && isHost(e));
  const cutoff = end?.eventId;
  const live = cutoff === undefined ? all : all.filter((e) => e.eventId <= cutoff);

  // The lobby: the host, then one join per person; a leave before the start takes it back.
  const lobby: LudoLobbyEntry[] = [
    {
      ...host,
      eventId: create.eventId,
      anchor: create.game.event.value.anchor,
      salt: create.game.event.value.salt,
    },
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
    });
  }
  const start = live.find((e) => e.game.event.case === 'start' && isHost(e));
  if (!start || start.game.event.case !== 'start') {
    const left = (entry: LudoLobbyEntry) =>
      live.some(
        (e) => e.game.event.case === 'leave' && same(e, entry) && e.eventId > entry.eventId,
      );
    game.lobby = lobby.filter((entry, i) => i === 0 || !left(entry));
    game.phase = end || left(lobby[0]!) ? 'ended' : 'lobby';
    return game;
  }
  game.lobby = lobby;

  // The seats, as the start fixed them.
  const wireSeats = start.game.event.value.seats;
  const seats: LudoNetSeat[] = wireSeats.map((s) => ({
    userId: bytesToUuid(s.userId),
    deviceId: bytesToUuid(s.deviceId),
    color: LUDO_COLORS[s.color]!,
    anchor: s.anchor,
    salt: s.salt,
  }));
  const problem = seatProblem(seats, lobby, game.maxPlayers);
  if (problem) return { ...game, phase: 'invalid', invalid: problem };
  seats.sort((a, b) => LUDO_COLORS.indexOf(a.color) - LUDO_COLORS.indexOf(b.color));
  game.seats = seats;
  const gameIdBytes = create.game.gameId;
  const first = firstSeat(
    sha256,
    gameIdBytes,
    seats.map((s) => s.salt),
  );
  let state = setupLudo(
    seats.map((s) => s.color),
    game.settings,
    seats[first]!.color,
  );
  game.initial = state;
  game.since = start.receivedAt;

  const seatOf = (e: Decoded) => seats.findIndex((s) => same(s, e));
  // Which roll events chain from each seat's anchor (eventId order, never skipping a secret).
  const chained = new Set<string>();
  game.rolls = seats.map((seat) => {
    let previous = seat.anchor;
    let count = 0;
    for (const e of all) {
      if (e.game.event.case !== 'roll' || !same(e, seat)) continue;
      const { reveal } = e.game.event.value;
      if (!isNextReveal(sha256, previous, reveal)) continue;
      chained.add(e.eventId);
      previous = reveal;
      count++;
    }
    return count;
  });

  const slots = new Map<string, Decoded[]>();
  const leaves: Decoded[] = [];
  for (const e of live) {
    const kind = e.game.event.case;
    if (seatOf(e) < 0) continue;
    if (kind === 'leave') leaves.push(e);
    if (kind !== 'roll' && kind !== 'move' && kind !== 'skip') continue;
    const key = `${e.game.turn}:${e.game.index}`;
    const list = slots.get(key);
    if (list) list.push(e);
    else slots.set(key, [e]);
  }

  // Salts in play order: the seats' own, then each applied step's.
  const salts: { deviceId: string; salt: Uint8Array }[] = seats.map((s) => ({
    deviceId: s.deviceId,
    salt: s.salt,
  }));
  const otherSalt = (deviceId: string): Uint8Array => {
    for (let i = salts.length - 1; i >= 0; i--) {
      if (salts[i]!.deviceId !== deviceId) return salts[i]!.salt;
    }
    return new Uint8Array(0);
  };
  const strikes = seats.map(() => 0);
  const used = new Set<string>();
  let index = 0;

  while (state.phase !== 'over') {
    const seat = state.current;
    const player = seats[seat]!;
    const candidates = [
      ...(slots.get(`${state.turns}:${index}`) ?? []),
      ...leaves.filter((e) => same(e, player) && e.game.turn <= state.turns),
    ]
      .filter((e) => !used.has(e.eventId) && acceptable(e))
      .sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    const chosen = candidates[0];
    if (!chosen) break;
    used.add(chosen.eventId);
    const by = { userId: chosen.userId, deviceId: chosen.deviceId };
    const entry = apply(chosen);
    game.entries.push({
      ...entry,
      eventId: chosen.eventId,
      seat,
      by,
      receivedAt: chosen.receivedAt,
    });
    game.since = Math.max(game.since, chosen.receivedAt);
    index = entry.state.turns !== state.turns ? 0 : index + 1;
    state = entry.state;
  }

  function acceptable(e: Decoded): boolean {
    const mine = same(e, seats[state.current]!);
    switch (e.game.event.case) {
      case 'leave':
        return mine;
      case 'roll':
        return mine && state.phase === 'roll' && chained.has(e.eventId);
      case 'skip':
        return !mine && state.phase === 'roll';
      case 'move': {
        if (state.phase !== 'move') return false;
        const { token } = e.game.event.value;
        if (mine) return legalTokens(state).includes(token);
        return token === proxyLudoToken(sha256, state);
      }
      default:
        return false;
    }
  }

  function apply(e: Decoded): Omit<LudoNetEntry, 'eventId' | 'seat' | 'by' | 'receivedAt'> {
    const seat = state.current;
    const event = e.game.event;
    switch (event.case) {
      case 'roll': {
        const die = rollDie(sha256, {
          reveal: event.value.reveal,
          salt: otherSalt(e.deviceId),
          gameId: gameIdBytes,
          turn: state.turns,
          index,
        });
        salts.push({ deviceId: e.deviceId, salt: event.value.salt });
        strikes[seat] = 0;
        const result = roll(state, die);
        return { kind: 'roll', state: result.state, roll: result };
      }
      case 'move': {
        const result = move(state, event.value.token);
        salts.push({ deviceId: e.deviceId, salt: event.value.salt });
        checkHash(event.value.stateHash, result.state);
        const kind = same(e, seats[seat]!) ? 'move' : 'proxy';
        return { kind, state: result.state, move: result };
      }
      case 'skip': {
        const next = applyLudoSkip(state, strikes[seat]!);
        strikes[seat]! += 1;
        salts.push({ deviceId: e.deviceId, salt: event.value.salt });
        checkHash(event.value.stateHash, next);
        return { kind: 'skip', state: next };
      }
      default:
        return { kind: 'leave', state: leave(state, seat) };
    }
  }

  function checkHash(claimed: Uint8Array, next: LudoState): void {
    if (!sameBytes(claimed, ludoStateHash(sha256, next))) game.desync = true;
  }

  game.state = state;
  game.turn = state.turns;
  game.index = index;
  game.strikes = strikes;
  game.phase = state.phase === 'over' ? 'over' : end ? 'ended' : 'playing';
  return game;
}

function seatProblem(
  seats: readonly LudoNetSeat[],
  lobby: readonly LudoLobbyEntry[],
  maxPlayers: number,
): string | null {
  if (seats.length < 2 || seats.length > maxPlayers) return 'wrong number of seats';
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(seats.map((s) => s.userId)) || !unique(seats.map((s) => s.deviceId))) {
    return 'a player has two seats';
  }
  if (!unique(seats.map((s) => s.color)) || seats.some((s) => s.color === undefined)) {
    return 'bad colors';
  }
  for (const seat of seats) {
    const joined = lobby.find((entry) => entry.deviceId === seat.deviceId);
    if (
      joined &&
      (joined.userId !== seat.userId ||
        !sameBytes(joined.anchor, seat.anchor) ||
        !sameBytes(joined.salt, seat.salt))
    ) {
      return 'a seat differs from its join';
    }
  }
  return null;
}

/** The seat this device plays, or −1 (watching, or not in the game). */
export function ludoSeatOf(game: LudoNetGame, self: GamePlayerRef): number {
  return game.seats.findIndex((s) => same(s, self));
}
