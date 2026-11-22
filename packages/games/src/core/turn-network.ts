// Turn games with friends (ADR 0049 third amendment): the same fold as Ludo's
// (`ludo/network.ts`), for any `TurnRules`. Every device folds the set of E2EE game events
// into the same game whatever order they arrived in.
// - Lobby: shared with Ludo (`net.ts`). The host's `start` lists the seats by place (0, 1, …);
//   who moves first is drawn from every seat's salt (Chess may let the host pick a side).
// - Play: every move, roll or skip fills the next step (`Game.turn`; `index` is 0). The seat to
//   play fills it; in games with a timer, once it ran out, anyone else seated may fill it with
//   the move the rules choose for the absent player (a proxy move) or, when a roll needs their
//   secret, a skip. Several candidates: the lowest event ID wins.
// - Three proxy moves or skips in a row and the player is out. A leave takes effect at the
//   first step after the leaver had seen (`Game.turn`), ordered against that step's moves by
//   event ID. The host's `end` stops the game; later events are ignored.
// - Moves, skips and dice rolls carry the resulting state's hash, so a desync shows.
import { bytesToUuid } from '@pingdost/protocol';

import { firstSeat, isNextReveal, rollDie, sameBytes, stateHash, type Sha256 } from './fair-dice';
import {
  decodeGameEvents,
  foldLobby,
  gameEmotes,
  samePlayer,
  type DecodedGameEvent,
  type GameEventLike,
  type GamePlayerRef,
  type LobbyEntry,
  type NetEmote,
} from './net';
import { seededRandom } from './random';
import type { NetStep, TurnCore, TurnGameId, TurnRules, TurnStep } from './turn';

export interface TurnNetSeat extends GamePlayerRef {
  /** The seat's place at the table (its index in `seats`). */
  place: number;
  anchor: Uint8Array;
  salt: Uint8Array;
  /** Hidden-hand games: what the seat committed to (ADR 0052). */
  data: Uint8Array;
}

/** One applied step (or leave), with the states around it. */
export interface TurnNetEntry<S, M> extends TurnStep<S, M> {
  eventId: string;
  by: GamePlayerRef;
  receivedAt: number;
}

/** As Ludo's: `missing` before the `create`, `invalid` for a bad start, `ended` by the host. */
export type TurnNetPhase = 'missing' | 'lobby' | 'playing' | 'over' | 'ended' | 'invalid';

export interface TurnNetGame<S, M, Settings> {
  gameId: string;
  type: TurnGameId;
  phase: TurnNetPhase;
  host: GamePlayerRef | null;
  maxPlayers: number;
  settings: Settings;
  createdAt: number;
  lobby: LobbyEntry[];
  /** After the start, by place: `seats[i]` plays seat i of the state. */
  seats: TurnNetSeat[];
  initial: S | null;
  state: S | null;
  entries: TurnNetEntry<S, M>[];
  /** When the open step opened here (receive time): its timer runs from this. */
  since: number;
  /** The open step. */
  turn: number;
  /** Proxy moves and skips in a row, per seat. */
  strikes: number[];
  /** Dice games: roll events per seat whose secrets chain (the next uses secret `rolls + 1`). */
  rolls: number[];
  /** Dice games: the salts in play order (the seats' own, then each applied step's). */
  salts: { deviceId: string; salt: Uint8Array }[];
  desync: boolean;
  invalid: string | null;
  emotes: NetEmote[];
}

/** Others wait this much longer than the timer before they play for an absent player. */
export const TURN_GRACE_MS = 10_000;
/** Proxy moves and skips in a row that take a player out. */
export const TURN_MAX_STRIKES = 3;

export function turnStateHash<S extends TurnCore>(
  rules: TurnRules<S, unknown, unknown>,
  sha256: Sha256,
  state: S,
): Uint8Array {
  return stateHash(sha256, `${rules.id}|${rules.canonical(state)}`);
}

/** The move a proxy must make for the current seat (null: this game has no proxy moves). */
export function proxyTurnMove<S extends TurnCore, M>(
  rules: TurnRules<S, M, unknown>,
  sha256: Sha256,
  state: S,
): M | null {
  if (!rules.proxy || rules.turnMs === null) return null;
  const hash = turnStateHash(rules, sha256, state);
  const seed = ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0;
  return rules.proxy(state, seededRandom(seed));
}

/** Applies a move: with friends, hidden-hand games use the step's salts (ADR 0052). */
export function applyTurnMove<S extends TurnCore, M>(
  rules: TurnRules<S, M, unknown>,
  state: S,
  move: M,
  step?: NetStep,
): S {
  return rules.hidden && step ? rules.hidden.applyNet(state, move, step) : rules.apply(state, move);
}

/** A missed step played for the current seat; the third in a row takes it out. */
export function missedTurn<S extends TurnCore, M>(
  rules: TurnRules<S, M, unknown>,
  state: S,
  strikes: number,
  move: M | null,
  step?: NetStep,
): S {
  const seat = state.current;
  const next = move === null ? rules.skip(state) : applyTurnMove(rules, state, move, step);
  return strikes + 1 >= TURN_MAX_STRIKES ? rules.leave(next, seat) : next;
}

function emptyGame<S extends TurnCore, M, Settings>(
  rules: TurnRules<S, M, Settings>,
  gameId: string,
): TurnNetGame<S, M, Settings> {
  return {
    gameId,
    type: rules.id,
    phase: 'missing',
    host: null,
    maxPlayers: rules.maxPlayers,
    settings: rules.defaultSettings,
    createdAt: 0,
    lobby: [],
    seats: [],
    initial: null,
    state: null,
    entries: [],
    since: 0,
    turn: 0,
    strikes: [],
    rolls: [],
    salts: [],
    desync: false,
    invalid: null,
    emotes: [],
  };
}

/** Folds a turn game's events (any order, duplicates allowed) into the game. */
export function foldTurnGame<S extends TurnCore, M, Settings>(
  rules: TurnRules<S, M, Settings>,
  gameId: string,
  events: readonly GameEventLike[],
  sha256: Sha256,
): TurnNetGame<S, M, Settings> {
  const all = decodeGameEvents(events);
  const game = emptyGame(rules, gameId);
  game.emotes = gameEmotes(all);

  const folded = foldLobby(gameId, all);
  if (!folded) return game;
  const { body, create, end, live, start, lobby } = folded;
  if (body.type !== rules.wireType) {
    return { ...game, phase: 'invalid', invalid: `not a ${rules.id} game` };
  }
  game.host = folded.host;
  game.maxPlayers = body.maxPlayers;
  game.settings = rules.settingsFromWire(body);
  game.createdAt = create.sentAt;
  game.lobby = lobby;
  if (body.maxPlayers < rules.minPlayers || body.maxPlayers > rules.maxPlayers) {
    return { ...game, phase: 'invalid', invalid: 'wrong table size' };
  }
  if (!start || start.game.event.case !== 'start') {
    game.phase = end || folded.hostLeft ? 'ended' : 'lobby';
    return game;
  }

  const seats: TurnNetSeat[] = start.game.event.value.seats.map((s) => ({
    userId: bytesToUuid(s.userId),
    deviceId: bytesToUuid(s.deviceId),
    place: s.color,
    anchor: s.anchor,
    salt: s.salt,
    data: s.seatData,
  }));
  const problem = seatProblem(seats, lobby, rules.minPlayers, game.maxPlayers);
  if (problem) return { ...game, phase: 'invalid', invalid: problem };
  seats.sort((a, b) => a.place - b.place);
  game.seats = seats;
  const gameIdBytes = create.game.gameId;
  const drawn = firstSeat(
    sha256,
    gameIdBytes,
    seats.map((s) => s.salt),
  );
  const hostSeat = Math.max(
    0,
    seats.findIndex((s) => samePlayer(s, folded.host)),
  );
  const first = rules.firstSeat?.(game.settings, drawn, hostSeat, seats.length) ?? drawn;
  let state = rules.hidden
    ? rules.hidden.setupNet(seats.length, game.settings, first, {
        sha256,
        gameId: gameIdBytes,
        seatData: seats.map((s) => s.data),
        salts: seats.map((s) => s.salt),
        startSalt: start.game.event.value.salt,
        host: hostSeat,
      })
    : rules.setup(seats.length, game.settings, first);
  game.initial = state;
  game.since = start.receivedAt;

  const seatOf = (e: GamePlayerRef) => seats.findIndex((s) => samePlayer(s, e));
  // Dice games: which roll events chain from each seat's anchor (never skipping a secret).
  const chained = new Set<string>();
  game.rolls = seats.map((seat) => {
    if (!rules.dice) return 0;
    let previous = seat.anchor;
    let count = 0;
    for (const e of all) {
      if (e.game.event.case !== 'roll' || !samePlayer(e, seat)) continue;
      const { reveal } = e.game.event.value;
      if (!isNextReveal(sha256, previous, reveal)) continue;
      chained.add(e.eventId);
      previous = reveal;
      count++;
    }
    return count;
  });

  const slots = new Map<number, DecodedGameEvent[]>();
  const leaves: DecodedGameEvent[] = [];
  for (const e of live) {
    const kind = e.game.event.case;
    if (seatOf(e) < 0) continue;
    if (kind === 'leave') leaves.push(e);
    if (kind !== 'roll' && kind !== 'move' && kind !== 'skip') continue;
    if (e.game.index !== 0) continue;
    const list = slots.get(e.game.turn);
    if (list) list.push(e);
    else slots.set(e.game.turn, [e]);
  }

  // Dice: salts in play order (the seats' own, then each applied step's).
  const salts: { deviceId: string; salt: Uint8Array }[] = seats.map((s) => ({
    deviceId: s.deviceId,
    salt: s.salt,
  }));
  const otherSalt = (deviceId: string) => saltFromOthers(salts, deviceId);
  // Hidden-hand games: a card drawn by a seat uses the latest salt by another device (ADR 0052).
  const stepNow = (): NetStep => ({
    sha256,
    gameId: gameIdBytes,
    saltFor: (seat) => saltFromOthers(salts, seats[seat]?.deviceId ?? ''),
  });
  const strikes = seats.map(() => 0);
  const used = new Set<string>();
  const decodedMoves = new Map<string, M | null>();
  const moveOf = (e: DecodedGameEvent): M | null => {
    if (e.game.event.case !== 'move') return null;
    if (!decodedMoves.has(e.eventId)) {
      decodedMoves.set(e.eventId, rules.moveFromWire(e.game.event.value));
    }
    return decodedMoves.get(e.eventId) ?? null;
  };
  let proxyCache: { turn: number; move: M | null } | null = null;
  const proxyNow = (): M | null => {
    if (proxyCache?.turn !== state.turns) {
      proxyCache = { turn: state.turns, move: proxyTurnMove(rules, sha256, state) };
    }
    return proxyCache.move;
  };

  while (!state.ranks) {
    const step = state.turns;
    const candidates = [
      ...(slots.get(step) ?? []).filter((e) => !used.has(e.eventId) && acceptable(e)),
      ...leaves.filter(
        (e) => !used.has(e.eventId) && e.game.turn <= step && !state.left[seatOf(e)],
      ),
    ].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    const chosen = candidates[0];
    if (!chosen) break;
    used.add(chosen.eventId);
    const before = state;
    const entry = apply(chosen);
    game.entries.push({
      ...entry,
      eventId: chosen.eventId,
      by: { userId: chosen.userId, deviceId: chosen.deviceId },
      receivedAt: chosen.receivedAt,
      before,
    });
    game.since = Math.max(game.since, chosen.receivedAt);
    state = entry.state;
  }

  function acceptable(e: DecodedGameEvent): boolean {
    const seat = seatOf(e);
    if (state.left[seat]) return false;
    const mine = seat === state.current;
    switch (e.game.event.case) {
      case 'roll':
        return rules.dice && mine && chained.has(e.eventId);
      case 'skip':
        return rules.dice && rules.turnMs !== null && !mine;
      case 'move': {
        if (rules.dice) return false;
        const move = moveOf(e);
        if (move === null) return false;
        if (mine) {
          return rules.hidden
            ? rules.hidden.isLegalNet(state, move, stepNow())
            : rules.isLegal(state, move);
        }
        const proxy = proxyNow();
        return proxy !== null && rules.sameMove(move, proxy);
      }
      default:
        return false;
    }
  }

  function apply(
    e: DecodedGameEvent,
  ): Omit<TurnNetEntry<S, M>, 'eventId' | 'by' | 'receivedAt' | 'before'> {
    const seat = state.current;
    const event = e.game.event;
    switch (event.case) {
      case 'roll': {
        const die = rollDie(sha256, {
          reveal: event.value.reveal,
          salt: otherSalt(e.deviceId),
          gameId: gameIdBytes,
          turn: state.turns,
          index: 0,
        });
        salts.push({ deviceId: e.deviceId, salt: event.value.salt });
        strikes[seat] = 0;
        const next = rules.roll!(state, die);
        if (event.value.stateHash.length > 0) checkHash(event.value.stateHash, next);
        return { kind: 'roll', seat, state: next, die };
      }
      case 'move': {
        const move = moveOf(e)!;
        salts.push({ deviceId: e.deviceId, salt: event.value.salt });
        if (seatOf(e) === seat) {
          strikes[seat] = 0;
          const next = applyTurnMove(rules, state, move, stepNow());
          checkHash(event.value.stateHash, next);
          return { kind: 'move', seat, state: next, move };
        }
        const next = missedTurn(rules, state, strikes[seat]!, move, stepNow());
        strikes[seat]! += 1;
        checkHash(event.value.stateHash, next);
        return { kind: 'proxy', seat, state: next, move };
      }
      case 'skip': {
        const next = missedTurn(rules, state, strikes[seat]!, null, stepNow());
        strikes[seat]! += 1;
        salts.push({ deviceId: e.deviceId, salt: event.value.salt });
        checkHash(event.value.stateHash, next);
        return { kind: 'skip', seat, state: next };
      }
      default: {
        const leaver = seatOf(e);
        return { kind: 'leave', seat: leaver, state: rules.leave(state, leaver) };
      }
    }
  }

  function checkHash(claimed: Uint8Array, next: S): void {
    if (!sameBytes(claimed, turnStateHash(rules, sha256, next))) game.desync = true;
  }

  game.state = state;
  game.turn = state.turns;
  game.strikes = strikes;
  game.salts = salts;
  game.phase = state.ranks ? 'over' : end ? 'ended' : 'playing';
  return game;
}

/** The salt a roll by `deviceId` uses: the latest one by another device. */
export function saltFromOthers(
  salts: readonly { deviceId: string; salt: Uint8Array }[],
  deviceId: string,
): Uint8Array {
  for (let i = salts.length - 1; i >= 0; i--) {
    if (salts[i]!.deviceId !== deviceId) return salts[i]!.salt;
  }
  return new Uint8Array(0);
}

function seatProblem(
  seats: readonly TurnNetSeat[],
  lobby: readonly LobbyEntry[],
  minPlayers: number,
  maxPlayers: number,
): string | null {
  if (seats.length < minPlayers || seats.length > maxPlayers) return 'wrong number of seats';
  const unique = (values: unknown[]) => new Set(values).size === values.length;
  if (!unique(seats.map((s) => s.userId)) || !unique(seats.map((s) => s.deviceId))) {
    return 'a player has two seats';
  }
  const places = seats.map((s) => s.place).sort((a, b) => a - b);
  if (places.some((place, i) => place !== i)) return 'bad places';
  for (const seat of seats) {
    const joined = lobby.find((entry) => entry.deviceId === seat.deviceId);
    if (
      joined &&
      (joined.userId !== seat.userId ||
        !sameBytes(joined.anchor, seat.anchor) ||
        !sameBytes(joined.salt, seat.salt) ||
        !sameBytes(joined.data, seat.data))
    ) {
      return 'a seat differs from its join';
    }
  }
  return null;
}

/** The seat this device plays, or −1 (watching, or not in the game). */
export function turnSeatOf(game: { seats: readonly GamePlayerRef[] }, self: GamePlayerRef): number {
  return game.seats.findIndex((s) => samePlayer(s, self));
}
