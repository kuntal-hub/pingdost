// Drives a turn game with friends for a screen (ADR 0049 third amendment), like
// `LudoNetController` for Ludo: it folds the game's events (`turn-network.ts`), shows each new
// step with the solo pace, sends this device's moves and rolls, and runs the timers of games
// that have them: at its own deadline the app plays for the user (the proxy move, or the
// roll); after someone else's deadline and a grace period it plays for them (or skips them
// when the roll needs their secret). Platform-free.
import { fromBase64, toBase64, uuidToBytes } from '@pingdost/protocol';

import { buildChain, revealAt, rollDie, sameBytes, type Sha256 } from './fair-dice';
import type { GameEventLike, GamePlayerRef } from './net';
import { NORMAL_TURN_PACE, type TurnCore, type TurnPace, type TurnRules } from './turn';
import type { TurnLast, TurnWaiting } from './turn-controller';
import { stepDuration } from './turn-controller';
import {
  foldTurnGame,
  missedTurn,
  proxyTurnMove,
  saltFromOthers,
  TURN_GRACE_MS,
  turnSeatOf,
  turnStateHash,
  type TurnNetGame,
} from './turn-network';
import type { GameEventInit, GameSendOptions } from '../ludo/network-controller';

/** What a game controller needs from the app: who this is, SHA-256, and a way to send. */
export interface GameNetPort {
  self: GamePlayerRef;
  sha256: Sha256;
  send(event: GameEventInit, options?: GameSendOptions): Promise<unknown>;
  randomBytes?(length: number): Uint8Array;
  now?(): number;
}

export interface TurnNetView<S, M, Settings> {
  game: TurnNetGame<S, M, Settings>;
  /** This device's seat, or −1 (watching). */
  you: number;
  /** The state as shown (it trails the folded state while steps animate); null before the start. */
  state: S | null;
  waiting: TurnWaiting;
  legal: M[];
  last: TurnLast<S, M> | null;
  /** When the open step's timer runs out (null: no timer, or nobody on the clock). */
  deadline: number | null;
  isHost: boolean;
  canJoin: boolean;
  canStart: boolean;
  /** Dice games: joined, but this device has no secret for its seat (it cannot roll). */
  locked: boolean;
}

export interface TurnNetControllerOptions<S extends TurnCore, M, Settings> {
  rules: TurnRules<S, M, Settings>;
  gameId: string;
  events: readonly GameEventLike[];
  /** The seat secret saved with this game on this device (base64), if it joined here. */
  seatSeed: string | null;
  port: GameNetPort;
  pace?: TurnPace;
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** A new game's `create` and the host's seat secret. */
export function createTurnEvent<S extends TurnCore, M, Settings>(
  rules: TurnRules<S, M, Settings>,
  sha256: Sha256,
  settings: Settings,
  maxPlayers: number,
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): { event: GameEventInit; seatSeed: string } {
  const seed = randomBytes(32);
  const chain = buildChain(sha256, seed);
  const players = Math.min(rules.maxPlayers, Math.max(rules.minPlayers, Math.floor(maxPlayers)));
  return {
    seatSeed: toBase64(seed),
    event: {
      event: {
        case: 'create',
        value: {
          type: rules.wireType,
          maxPlayers: players,
          settings: rules.settingsToWire(rules.normalizeSettings(settings)),
          anchor: chain[chain.length - 1]!,
          salt: randomBytes(16),
        },
      },
    },
  };
}

export class TurnNetController<S extends TurnCore, M, Settings> {
  #options: TurnNetControllerOptions<S, M, Settings>;
  #events: readonly GameEventLike[];
  #game: TurnNetGame<S, M, Settings>;
  #chain: Uint8Array[] | null = null;
  #view: TurnNetView<S, M, Settings>;
  #listeners = new Set<() => void>();
  #disposed = false;
  #counter = 0;
  #shown: number;
  #presented: S | null;
  #animating: string | null = null;
  #stepTimer: ReturnType<typeof setTimeout> | null = null;
  #clockTimer: ReturnType<typeof setTimeout> | null = null;
  /** Steps this device already acted on, so a timer and a tap never send twice. */
  #acted = new Set<number>();
  #tumbleSince = 0;
  #startSent = false;
  #last: TurnLast<S, M> | null = null;
  #waitingOverride: TurnWaiting | null = null;

  constructor(options: TurnNetControllerOptions<S, M, Settings>) {
    this.#options = options;
    this.#events = options.events;
    this.#game = this.#fold();
    // History is shown as it stands; only what happens from now on is animated.
    this.#shown = this.#game.entries.length;
    this.#presented = this.#game.state;
    const lastEntry = this.#game.entries[this.#shown - 1];
    if (lastEntry && lastEntry.kind !== 'leave') this.#last = { ...lastEntry, id: ++this.#counter };
    this.#view = this.#buildView();
    this.#afterChange();
  }

  get rules(): TurnRules<S, M, Settings> {
    return this.#options.rules;
  }

  getView = (): TurnNetView<S, M, Settings> => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setPace(pace: TurnPace): void {
    this.#options = { ...this.#options, pace };
  }

  /** The game's events changed (one arrived or was sent). */
  update(events: readonly GameEventLike[], seatSeed?: string | null): void {
    if (this.#disposed) return;
    this.#events = events;
    if (seatSeed !== undefined && seatSeed !== this.#options.seatSeed) {
      this.#options = { ...this.#options, seatSeed };
      this.#chain = null;
    }
    const before = this.#game.entries;
    this.#game = this.#fold();
    const after = this.#game.entries;
    let common = 0;
    while (
      common < this.#shown &&
      common < after.length &&
      before[common]?.eventId === after[common]!.eventId
    ) {
      common++;
    }
    if (
      common < this.#shown ||
      (this.#animating && !after.some((e) => e.eventId === this.#animating))
    ) {
      this.#stopStep();
      this.#shown = common;
      this.#presented = common > 0 ? after[common - 1]!.state : this.#game.initial;
    }
    if (!this.#presented && this.#game.initial) this.#presented = this.#game.initial;
    this.#afterChange();
  }

  // Actions

  move(move: M): void {
    const state = this.#game.state;
    if (this.#game.phase !== 'playing' || !state || this.rules.dice) return;
    if (state.current !== this.#you || !this.rules.isLegal(state, move)) return;
    this.#sendMove(move, false);
  }

  roll(): void {
    const game = this.#game;
    const state = game.state;
    const you = this.#you;
    if (game.phase !== 'playing' || !state || !this.rules.dice) return;
    if (state.current !== you || this.#locked) return;
    const step = state.turns;
    if (this.#acted.has(step)) return;
    this.#acted.add(step);
    const reveal = revealAt(this.#chainOrThrow(), game.rolls[you]! + 1);
    const die = rollDie(this.#port.sha256, {
      reveal,
      salt: saltFromOthers(game.salts, this.#port.self.deviceId),
      gameId: uuidToBytes(game.gameId),
      turn: step,
      index: 0,
    });
    const next = this.rules.roll!(state, die);
    if (this.#caughtUp) {
      this.#tumbleSince = this.#now();
      this.#waitingOverride = 'rolling';
      this.#refresh();
    }
    this.#sendStep(
      {
        case: 'roll',
        value: {
          reveal,
          salt: this.#random(16),
          stateHash: turnStateHash(this.rules, this.#port.sha256, next),
        },
      },
      step,
    );
  }

  join(): void {
    if (!this.#view.canJoin) return;
    const seed = this.#random(32);
    const chain = buildChain(this.#port.sha256, seed);
    this.#chain = chain;
    const seatSeed = toBase64(seed);
    this.#options = { ...this.#options, seatSeed };
    void this.#send(
      { case: 'join', value: { anchor: chain[chain.length - 1]!, salt: this.#random(16) } },
      { seatSeed },
    );
  }

  /** The host starts with everyone who joined so far (up to the table's size). */
  start(): void {
    if (!this.#view.canStart || this.#startSent) return;
    this.#startSent = true;
    const players = this.#game.lobby.slice(0, this.#game.maxPlayers);
    void this.#send({
      case: 'start',
      value: {
        seats: players.map((p, i) => ({
          userId: uuidToBytes(p.userId),
          deviceId: uuidToBytes(p.deviceId),
          color: i,
          anchor: p.anchor,
          salt: p.salt,
        })),
      },
    }).catch(() => {
      this.#startSent = false;
    });
  }

  leave(): void {
    void this.#send({ case: 'leave', value: {} });
  }

  /** The host ends the game for everyone. */
  end(): void {
    if (!this.#view.isHost) return;
    void this.#send({ case: 'end', value: {} });
  }

  emote(emoji: string): void {
    void this.#send({ case: 'emote', value: { emoji } });
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopStep();
    if (this.#clockTimer) clearTimeout(this.#clockTimer);
    this.#clockTimer = null;
    this.#listeners.clear();
  }

  // Folding and sending

  get #port(): GameNetPort {
    return this.#options.port;
  }

  get #pace(): TurnPace {
    return this.#options.pace ?? NORMAL_TURN_PACE;
  }

  get #you(): number {
    return turnSeatOf(this.#game, this.#port.self);
  }

  get #locked(): boolean {
    const you = this.#you;
    if (you < 0 || !this.rules.dice) return false;
    const chain = this.#chainOrNull();
    return !chain || !sameBytes(chain[chain.length - 1]!, this.#game.seats[you]!.anchor);
  }

  get #caughtUp(): boolean {
    return this.#shown >= this.#game.entries.length && this.#animating === null;
  }

  #now(): number {
    return this.#port.now?.() ?? Date.now();
  }

  #random(length: number): Uint8Array {
    return (this.#port.randomBytes ?? defaultRandomBytes)(length);
  }

  #fold(): TurnNetGame<S, M, Settings> {
    return foldTurnGame(this.rules, this.#options.gameId, this.#events, this.#port.sha256);
  }

  #chainOrNull(): Uint8Array[] | null {
    if (!this.#chain && this.#options.seatSeed) {
      this.#chain = buildChain(this.#port.sha256, fromBase64(this.#options.seatSeed));
    }
    return this.#chain;
  }

  #chainOrThrow(): Uint8Array[] {
    const chain = this.#chainOrNull();
    if (!chain) throw new Error('no seat secret on this device');
    return chain;
  }

  #send(event: GameEventInit['event'], options?: GameSendOptions): Promise<unknown> {
    return this.#port.send(
      { gameId: uuidToBytes(this.#options.gameId), turn: this.#game.turn, index: 0, event },
      options,
    );
  }

  #sendStep(event: GameEventInit['event'], step: number): void {
    this.#send(event).catch(() => {
      this.#acted.delete(step);
      this.#waitingOverride = null;
      this.#refresh();
    });
  }

  /** Sends a move: the user's own, or (`forOther`) the proxy move for an absent player. */
  #sendMove(move: M, forOther: boolean): void {
    const state = this.#game.state!;
    const step = state.turns;
    if (this.#acted.has(step)) return;
    this.#acted.add(step);
    const next = forOther
      ? missedTurn(this.rules, state, this.#game.strikes[state.current]!, move)
      : this.rules.apply(state, move);
    if (this.#caughtUp && !forOther) {
      this.#waitingOverride = 'moving';
      this.#refresh();
    }
    this.#sendStep(
      {
        case: 'move',
        value: {
          salt: this.#random(16),
          stateHash: turnStateHash(this.rules, this.#port.sha256, next),
          play: this.rules.moveToWire(move),
        },
      },
      step,
    );
  }

  #sendSkip(): void {
    const state = this.#game.state!;
    const step = state.turns;
    if (this.#acted.has(step)) return;
    this.#acted.add(step);
    const next = missedTurn(this.rules, state, this.#game.strikes[state.current]!, null);
    this.#sendStep(
      {
        case: 'skip',
        value: {
          salt: this.#random(16),
          stateHash: turnStateHash(this.rules, this.#port.sha256, next),
        },
      },
      step,
    );
  }

  // Showing steps one by one

  #afterChange(): void {
    const game = this.#game;
    this.#view = this.#buildView();
    if (
      game.phase === 'lobby' &&
      game.host &&
      game.host.deviceId === this.#port.self.deviceId &&
      game.lobby.length >= game.maxPlayers
    ) {
      this.start();
    }
    if (this.#animating === null) this.#advance();
    else this.#refresh();
    this.#scheduleClock();
  }

  #advance(): void {
    if (this.#disposed) return;
    const entry = this.#game.entries[this.#shown];
    if (!entry) {
      this.#animating = null;
      this.#refresh();
      return;
    }
    this.#animating = entry.eventId;
    const pace = this.#pace;
    const finish = (wait: number) => {
      this.#stepTimer = setTimeout(() => {
        this.#stepTimer = null;
        this.#presented = entry.state;
        this.#shown++;
        this.#animating = null;
        this.#advance();
      }, wait);
    };
    if (entry.kind === 'leave') {
      this.#waitingOverride = null;
      this.#presented = entry.state;
      this.#refresh();
      finish(pace.read);
      return;
    }
    const show = () => {
      this.#waitingOverride = null;
      this.#last = { ...entry, id: ++this.#counter };
      this.#presented = entry.state;
      this.#refresh('moving');
      finish(stepDuration(this.rules, entry, pace));
    };
    if (entry.kind === 'roll') {
      // The die tumbles for the pace's roll time, counted from the tap if it was ours.
      const tumbled = this.#waitingOverride === 'rolling' ? this.#now() - this.#tumbleSince : 0;
      this.#waitingOverride = 'rolling';
      this.#refresh();
      this.#stepTimer = setTimeout(
        () => {
          this.#stepTimer = null;
          show();
        },
        Math.max(0, pace.roll - tumbled),
      );
      return;
    }
    show();
  }

  #stopStep(): void {
    if (this.#stepTimer) clearTimeout(this.#stepTimer);
    this.#stepTimer = null;
    this.#animating = null;
  }

  #refresh(waiting?: TurnWaiting): void {
    if (this.#disposed) return;
    this.#view = this.#buildView(waiting);
    for (const listener of this.#listeners) listener();
  }

  #buildView(waiting?: TurnWaiting): TurnNetView<S, M, Settings> {
    const game = this.#game;
    const you = this.#you;
    const self = this.#port.self;
    const isHost = game.host?.deviceId === self.deviceId && game.host.userId === self.userId;
    const inLobby = game.lobby.some((e) => e.userId === self.userId);
    const locked = this.#locked;
    const state = this.#presented ?? game.state;
    const now = state
      ? (waiting ?? this.#waitingOverride ?? this.#settledWaiting(state, you, locked))
      : 'them';
    const turnMs = this.rules.turnMs;
    return {
      game,
      you,
      state,
      waiting: now,
      legal: now === 'you' && state && !this.rules.dice ? this.rules.legal(state) : [],
      last: this.#last,
      deadline: game.phase === 'playing' && turnMs !== null ? game.since + turnMs : null,
      isHost,
      canJoin: game.phase === 'lobby' && !inLobby && game.lobby.length < game.maxPlayers,
      canStart: game.phase === 'lobby' && isHost && game.lobby.length >= this.rules.minPlayers,
      locked,
    };
  }

  #settledWaiting(state: S, you: number, locked: boolean): TurnWaiting {
    if (this.#game.phase !== 'playing' || state.ranks) return 'over';
    if (!this.#caughtUp) return 'moving';
    if (state.current !== you || locked) return 'them';
    if (this.#acted.has(state.turns)) return this.rules.dice ? 'rolling' : 'moving';
    return 'you';
  }

  // Timers

  #scheduleClock(): void {
    if (this.#clockTimer) clearTimeout(this.#clockTimer);
    this.#clockTimer = null;
    const game = this.#game;
    const state = game.state;
    const you = this.#you;
    const turnMs = this.rules.turnMs;
    if (this.#disposed || turnMs === null || game.phase !== 'playing' || !state || you < 0) return;
    if (state.left[you]) return;
    const count = game.seats.length;
    const mine = state.current === you;
    const distance = (you - state.current + count) % count;
    const at = mine
      ? game.since + turnMs
      : game.since + turnMs + TURN_GRACE_MS + Math.max(0, distance - 1) * 3_000;
    const step = state.turns;
    this.#clockTimer = setTimeout(
      () => {
        this.#clockTimer = null;
        const now = this.#game.state;
        if (!now || now.turns !== step || this.#game.phase !== 'playing') return;
        if (this.rules.dice) {
          if (mine) this.roll();
          else this.#sendSkip();
          return;
        }
        const proxy = proxyTurnMove(this.rules, this.#port.sha256, now);
        if (proxy === null) return;
        if (mine) this.move(proxy);
        else this.#sendMove(proxy, true);
      },
      Math.max(0, at - this.#now()),
    );
  }
}
