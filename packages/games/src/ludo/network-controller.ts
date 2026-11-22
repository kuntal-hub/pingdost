// Drives a Ludo game with friends for a screen (ADR 0049): it folds the game's events
// (`network.ts`), shows each new step with the same pauses as a solo game (dice tumbling,
// hopping pieces), sends this device's rolls and moves, and runs the timers: at its own
// deadline the app rolls or moves for the user; after someone else's deadline and a grace
// period it skips them (before they rolled) or moves for them. Platform-free: the apps
// subscribe with `useSyncExternalStore`.
import {
  fromBase64,
  GameType,
  toBase64,
  uuidToBytes,
  type GameSchema,
  type MessageInitShape,
} from '@pingdost/protocol';

import { LUDO_COLORS, YARD, type LudoColor } from './board';
import { NORMAL_PACE, type LudoPace, type LudoView, type LudoWaiting } from './controller';
import {
  applyLudoSkip,
  foldLudoGame,
  LUDO_GRACE_MS,
  LUDO_TURN_MS,
  ludoSeatOf,
  ludoStateHash,
  proxyLudoToken,
  type LudoNetGame,
} from './network';
import {
  colorsFor,
  distinctTokens,
  legalTokens,
  move,
  type LudoSettings,
  type LudoState,
} from './rules';
import { buildChain, revealAt, sameBytes, type Sha256 } from '../core/fair-dice';
import type { GameEventLike, GamePlayerRef } from '../core/net';
import type { SeatKind } from '../core/types';

export type GameEventInit = MessageInitShape<typeof GameSchema>;

export interface GameSendOptions {
  /** This device's seat secret, stored with the event and never sent. */
  seatSeed?: string;
}

/** What the controller needs from the app: who this is, SHA-256, and a way to send. */
export interface LudoNetPort {
  self: GamePlayerRef;
  sha256: Sha256;
  send(event: GameEventInit, options?: GameSendOptions): Promise<unknown>;
  randomBytes?(length: number): Uint8Array;
  now?(): number;
}

export interface LudoNetView {
  game: LudoNetGame;
  /** This device's seat, or −1 (watching). */
  you: number;
  /** The board as a solo game's screen draws it (null before the start). */
  board: LudoView | null;
  /** When the open step's timer runs out (null when nobody is on the clock). */
  deadline: number | null;
  isHost: boolean;
  canJoin: boolean;
  canStart: boolean;
  /** Joined, but this device has no secret for its seat (it cannot roll). */
  locked: boolean;
}

export interface LudoNetControllerOptions {
  gameId: string;
  events: readonly GameEventLike[];
  /** The seat secret saved with this game on this device (base64), if it joined here. */
  seatSeed: string | null;
  port: LudoNetPort;
  pace?: LudoPace;
  autoMove?: boolean;
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** A new game's `create` and the host's seat secret. */
export function createLudoEvent(
  sha256: Sha256,
  settings: LudoSettings,
  maxPlayers: number,
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): { event: GameEventInit; seatSeed: string } {
  const seed = randomBytes(32);
  const chain = buildChain(sha256, seed);
  return {
    seatSeed: toBase64(seed),
    event: {
      event: {
        case: 'create',
        value: {
          type: GameType.LUDO,
          maxPlayers,
          settings: {
            case: 'ludo',
            value: {
              anyRollStarts: !settings.needSix,
              blockades: settings.blockades,
              stopAtFirstWinner: settings.stopAtFirstWinner,
            },
          },
          anchor: chain[chain.length - 1]!,
          salt: randomBytes(16),
        },
      },
    },
  };
}

export class LudoNetController {
  #options: LudoNetControllerOptions;
  #events: readonly GameEventLike[];
  #game: LudoNetGame;
  #chain: Uint8Array[] | null = null;
  #view: LudoNetView;
  #listeners = new Set<() => void>();
  #disposed = false;
  #counter = 0;
  /** Steps shown so far, and the state they leave. */
  #shown: number;
  #presented: LudoState | null;
  #animating: string | null = null;
  #stepTimer: ReturnType<typeof setTimeout> | null = null;
  #clockTimer: ReturnType<typeof setTimeout> | null = null;
  #autoTimer: ReturnType<typeof setTimeout> | null = null;
  /** Slots this device already acted on, so a timer and a tap never send twice. */
  #acted = new Set<string>();
  #tumbleSince = 0;
  #startSent = false;
  #lastRoll: LudoView['lastRoll'] = null;
  #lastMove: LudoView['lastMove'] = null;
  #waitingOverride: LudoWaiting | null = null;

  constructor(options: LudoNetControllerOptions) {
    this.#options = options;
    this.#events = options.events;
    this.#game = this.#fold();
    // History is shown as it stands; only what happens from now on is animated.
    this.#shown = this.#game.entries.length;
    this.#presented = this.#game.state;
    this.#view = this.#buildView();
    this.#afterChange();
  }

  getView = (): LudoNetView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setPace(pace: LudoPace): void {
    this.#options = { ...this.#options, pace };
  }

  setAutoMove(autoMove: boolean): void {
    this.#options = { ...this.#options, autoMove };
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
    // Where the old and the new steps part (a lower event ID won a slot after all).
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

  roll(): void {
    const game = this.#game;
    const you = this.#you;
    if (game.phase !== 'playing' || !game.state || game.state.phase !== 'roll') return;
    if (game.state.current !== you || this.#locked) return;
    const slot = this.#slot();
    if (this.#acted.has(slot)) return;
    this.#acted.add(slot);
    const reveal = revealAt(this.#chainOrThrow(), game.rolls[you]! + 1);
    if (this.#caughtUp) {
      this.#tumbleSince = this.#now();
      this.#waitingOverride = 'rolling';
      this.#refresh();
    }
    this.#sendTurn({ case: 'roll', value: { reveal, salt: this.#random(16) } }, slot);
  }

  move(token: number): void {
    const state = this.#game.state;
    if (this.#game.phase !== 'playing' || !state || state.phase !== 'move') return;
    if (state.current !== this.#you || !legalTokens(state).includes(token)) return;
    this.#sendMove(token);
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
  start(hostColor: LudoColor = 'red'): void {
    if (!this.#view.canStart || this.#startSent) return;
    this.#startSent = true;
    const players = this.#game.lobby.slice(0, this.#game.maxPlayers);
    const colors = colorsFor(players.length, hostColor);
    void this.#send({
      case: 'start',
      value: {
        seats: players.map((p, i) => ({
          userId: uuidToBytes(p.userId),
          deviceId: uuidToBytes(p.deviceId),
          color: LUDO_COLORS.indexOf(colors[i]!),
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
    this.#clearClock();
    this.#listeners.clear();
  }

  // Folding and sending

  get #port(): LudoNetPort {
    return this.#options.port;
  }

  get #pace(): LudoPace {
    return this.#options.pace ?? NORMAL_PACE;
  }

  get #you(): number {
    return ludoSeatOf(this.#game, this.#port.self);
  }

  get #locked(): boolean {
    const you = this.#you;
    if (you < 0) return false;
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

  #fold(): LudoNetGame {
    return foldLudoGame(this.#options.gameId, this.#events, this.#port.sha256);
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

  #slot(): string {
    return `${this.#game.turn}:${this.#game.index}`;
  }

  #send(event: GameEventInit['event'], options?: GameSendOptions): Promise<unknown> {
    return this.#port.send(
      {
        gameId: uuidToBytes(this.#options.gameId),
        turn: this.#game.turn,
        index: this.#game.index,
        event,
      },
      options,
    );
  }

  #sendTurn(event: GameEventInit['event'], slot: string): void {
    this.#send(event).catch(() => {
      this.#acted.delete(slot);
      this.#waitingOverride = null;
      this.#refresh();
    });
  }

  #sendMove(token: number): void {
    const state = this.#game.state!;
    const slot = this.#slot();
    if (this.#acted.has(slot)) return;
    this.#acted.add(slot);
    const next = move(state, token).state;
    if (this.#caughtUp) {
      this.#waitingOverride = 'moving';
      this.#refresh();
    }
    this.#sendTurn(
      {
        case: 'move',
        value: { token, salt: this.#random(16), stateHash: ludoStateHash(this.#port.sha256, next) },
      },
      slot,
    );
  }

  #sendSkip(): void {
    const state = this.#game.state!;
    const slot = this.#slot();
    if (this.#acted.has(slot)) return;
    this.#acted.add(slot);
    const next = applyLudoSkip(state, this.#game.strikes[state.current]!);
    this.#sendTurn(
      {
        case: 'skip',
        value: { salt: this.#random(16), stateHash: ludoStateHash(this.#port.sha256, next) },
      },
      slot,
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
      this.#scheduleAutoMove();
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
    if (entry.kind === 'roll' && entry.roll) {
      const result = entry.roll;
      // The die tumbles for the pace's roll time, counted from the tap if it was ours.
      const tumbled = this.#waitingOverride === 'rolling' ? this.#now() - this.#tumbleSince : 0;
      this.#waitingOverride = 'rolling';
      this.#refresh();
      this.#stepTimer = setTimeout(
        () => {
          this.#stepTimer = null;
          this.#waitingOverride = null;
          this.#lastRoll = { ...result, id: ++this.#counter };
          if (result.outcome === 'move') {
            this.#presented = entry.state;
            this.#refresh('moving');
            finish(pace.read);
          } else {
            // A roll that moves nothing stays the roller's turn while it is read.
            this.#presented = { ...entry.state, current: entry.seat };
            this.#refresh('computer');
            finish(pace.read + pace.think / 2);
          }
        },
        Math.max(0, pace.roll - tumbled),
      );
      return;
    }
    this.#waitingOverride = null;
    this.#presented = entry.state;
    if (entry.move) {
      const result = entry.move;
      this.#lastMove = { ...result, id: ++this.#counter };
      this.#refresh('moving');
      const hops = result.from === YARD ? 1 : result.to - result.from;
      finish(hops * pace.hop + (result.captures.length > 0 ? pace.capture : 0) + 120);
      return;
    }
    this.#refresh();
    finish(pace.read);
  }

  #stopStep(): void {
    if (this.#stepTimer) clearTimeout(this.#stepTimer);
    this.#stepTimer = null;
    this.#animating = null;
  }

  #refresh(waiting?: LudoWaiting): void {
    if (this.#disposed) return;
    this.#view = this.#buildView(waiting);
    for (const listener of this.#listeners) listener();
  }

  #buildView(waiting?: LudoWaiting): LudoNetView {
    const game = this.#game;
    const you = this.#you;
    const self = this.#port.self;
    const isHost = game.host?.deviceId === self.deviceId && game.host.userId === self.userId;
    const inLobby = game.lobby.some((e) => e.userId === self.userId);
    const locked = this.#locked;
    const state = this.#presented ?? game.state;
    let board: LudoView | null = null;
    if (state && game.seats.length > 0) {
      const seats: SeatKind[] = game.seats.map((_, i) => (i === you ? 'you' : 'friend'));
      const now = waiting ?? this.#waitingOverride ?? this.#settledWaiting(state, you, locked);
      board = {
        state,
        seats,
        you,
        waiting: now,
        movable: now === 'you-move' ? legalTokens(state) : [],
        lastRoll: this.#lastRoll,
        lastMove: this.#lastMove,
      };
    }
    return {
      game,
      you,
      board,
      deadline: game.phase === 'playing' ? game.since + LUDO_TURN_MS : null,
      isHost,
      canJoin: game.phase === 'lobby' && !inLobby && game.lobby.length < game.maxPlayers,
      canStart: game.phase === 'lobby' && isHost && game.lobby.length >= 2,
      locked,
    };
  }

  #settledWaiting(state: LudoState, you: number, locked: boolean): LudoWaiting {
    if (this.#game.phase !== 'playing' || state.phase === 'over') return 'over';
    if (!this.#caughtUp) return state.phase === 'move' ? 'moving' : 'computer';
    if (state.current !== you || locked) return 'computer';
    if (this.#acted.has(this.#slot())) return state.phase === 'move' ? 'moving' : 'rolling';
    return state.phase === 'move' ? 'you-move' : 'you-roll';
  }

  // Timers

  #clearClock(): void {
    if (this.#clockTimer) clearTimeout(this.#clockTimer);
    if (this.#autoTimer) clearTimeout(this.#autoTimer);
    this.#clockTimer = null;
    this.#autoTimer = null;
  }

  // With only one way to move, the app moves by itself (the user's Auto-move setting).
  #scheduleAutoMove(): void {
    if (this.#autoTimer) clearTimeout(this.#autoTimer);
    this.#autoTimer = null;
    const state = this.#game.state;
    if (!this.#options.autoMove || this.#game.phase !== 'playing' || !state) return;
    if (state.phase !== 'move' || state.current !== this.#you || this.#locked) return;
    const distinct = distinctTokens(state);
    if (distinct.length !== 1 || this.#acted.has(this.#slot())) return;
    this.#autoTimer = setTimeout(() => {
      this.#autoTimer = null;
      this.move(distinct[0]!);
    }, this.#pace.read);
  }

  #scheduleClock(): void {
    if (this.#clockTimer) clearTimeout(this.#clockTimer);
    this.#clockTimer = null;
    const game = this.#game;
    const state = game.state;
    const you = this.#you;
    if (this.#disposed || game.phase !== 'playing' || !state || you < 0) return;
    if (game.state?.players[you]?.left) return;
    const count = game.seats.length;
    const mine = state.current === you;
    const distance = (you - state.current + count) % count;
    const at = mine
      ? game.since + LUDO_TURN_MS
      : game.since + LUDO_TURN_MS + LUDO_GRACE_MS + Math.max(0, distance - 1) * 3_000;
    const slot = this.#slot();
    this.#clockTimer = setTimeout(
      () => {
        this.#clockTimer = null;
        if (this.#slot() !== slot || this.#game.phase !== 'playing') return;
        const now = this.#game.state!;
        if (mine) {
          if (now.phase === 'roll') this.roll();
          else this.move(proxyLudoToken(this.#port.sha256, now));
        } else if (now.phase === 'roll') {
          this.#sendSkip();
        } else {
          this.#sendMove(proxyLudoToken(this.#port.sha256, now));
        }
      },
      Math.max(0, at - this.#now()),
    );
  }
}
