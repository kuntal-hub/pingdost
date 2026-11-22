// Drives a Ludo game for a screen: the user's taps, the computer players' turns, and pauses
// long enough for the dice and the hopping pieces to be seen. Platform-free: the apps
// subscribe to it (`useSyncExternalStore`) and draw `view`.
import { YARD } from './board';
import { chooseLudoToken } from './bot';
import {
  distinctTokens,
  forfeitLudo,
  legalTokens,
  move,
  roll,
  standings,
  type LudoState,
  type MoveResult,
  type RollResult,
} from './rules';
import type { Random } from '../core/random';
import type { BotLevel, SeatKind } from '../core/types';

/** Timings in milliseconds. `fastPace` suits Motion Off (moves are still visible). */
export interface LudoPace {
  /** The dice spinning. */
  roll: number;
  /** One square of a piece's hop. */
  hop: number;
  /** A captured piece flying home. */
  capture: number;
  /** After a roll, before the move (to read the die). */
  read: number;
  /** A computer player's pause before it rolls. */
  think: number;
}

// The die tumbles for 800 ms (the user asked for 500–1000 ms); a hop is one arc per square.
export const NORMAL_PACE: LudoPace = { roll: 800, hop: 170, capture: 450, read: 350, think: 500 };
export const FAST_PACE: LudoPace = { roll: 200, hop: 40, capture: 120, read: 250, think: 300 };

export type LudoWaiting = 'you-roll' | 'you-move' | 'rolling' | 'moving' | 'computer' | 'over';

export interface LudoView {
  state: LudoState;
  seats: readonly SeatKind[];
  /** The user's seat. */
  you: number;
  waiting: LudoWaiting;
  /** Pieces the user may tap now. */
  movable: number[];
  /** The latest roll (with a counter, so the same number twice still animates). */
  lastRoll: (RollResult & { id: number }) | null;
  /** The latest move, for the hop animation. */
  lastMove: (MoveResult & { id: number }) | null;
}

export interface LudoControllerOptions {
  state: LudoState;
  seats: readonly SeatKind[];
  level: BotLevel;
  random: Random;
  pace?: LudoPace;
  /** Move the user's only possible piece by itself. */
  autoMove?: boolean;
  /** After every change of the game state: save it. */
  onState?: (state: LudoState) => void;
  /** Once, when the game ends: the user's place (1 = won). */
  onOver?: (place: number) => void;
}

export class LudoController {
  #options: LudoControllerOptions;
  #view: LudoView;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #listeners = new Set<() => void>();
  #counter = 0;
  #disposed = false;
  #reportedOver = false;

  constructor(options: LudoControllerOptions) {
    this.#options = options;
    const you = options.seats.indexOf('you');
    if (you < 0) throw new Error('a solo game needs the user in it');
    this.#view = {
      state: options.state,
      seats: options.seats,
      you,
      waiting: 'computer',
      movable: [],
      lastRoll: null,
      lastMove: null,
    };
    this.#settle();
  }

  getView = (): LudoView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Faster or normal animations, e.g. when the user changes Motion. */
  setPace(pace: LudoPace): void {
    this.#options = { ...this.#options, pace };
  }

  setAutoMove(autoMove: boolean): void {
    this.#options = { ...this.#options, autoMove };
  }

  /** The user rolls. */
  roll(): void {
    if (this.#view.waiting !== 'you-roll') return;
    this.#roll();
  }

  /** The user moves a piece. */
  move(token: number): void {
    if (this.#view.waiting !== 'you-move' || !this.#view.movable.includes(token)) return;
    this.#move(token);
  }

  /**
   * The user quits before the end, which counts as a loss: the game ends at once with them last
   * (`onOver` runs before this returns, so the screen may leave right after).
   */
  resign(): void {
    const { state, you } = this.#view;
    if (state.phase === 'over' || this.#disposed) return;
    this.#clearTimers();
    const next = forfeitLudo(state, you);
    this.#update({ state: next });
    this.#options.onState?.(next);
    this.#settle();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimers();
    this.#listeners.clear();
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  get #pace(): LudoPace {
    return this.#options.pace ?? NORMAL_PACE;
  }

  #roll(): void {
    this.#update({ waiting: 'rolling', movable: [] });
    this.#after(this.#pace.roll, () => {
      const result = roll(this.#view.state, this.#options.random.die());
      this.#update({
        state: result.state,
        lastRoll: { ...result, id: ++this.#counter },
        waiting: result.outcome === 'move' ? 'moving' : 'rolling',
      });
      this.#options.onState?.(result.state);
      if (result.outcome !== 'move') {
        // Show the useless roll a moment, then the next turn.
        this.#after(this.#pace.read + this.#pace.think / 2, () => this.#settle());
        return;
      }
      this.#afterRoll();
    });
  }

  #afterRoll(): void {
    const { state } = this.#view;
    if (state.current === this.#view.you) {
      const distinct = distinctTokens(state);
      if (this.#options.autoMove && distinct.length === 1) {
        this.#update({ waiting: 'moving', movable: [] });
        this.#after(this.#pace.read, () => this.#move(distinct[0]!));
        return;
      }
      this.#update({ waiting: 'you-move', movable: legalTokens(state) });
      return;
    }
    this.#after(this.#pace.read, () => {
      this.#move(chooseLudoToken(this.#view.state, this.#options.level, this.#options.random));
    });
  }

  #move(token: number): void {
    const result = move(this.#view.state, token);
    this.#update({
      state: result.state,
      lastMove: { ...result, id: ++this.#counter },
      waiting: 'moving',
      movable: [],
    });
    this.#options.onState?.(result.state);
    const hops = result.from === YARD ? 1 : result.to - result.from;
    const wait =
      hops * this.#pace.hop + (result.captures.length > 0 ? this.#pace.capture : 0) + 120;
    this.#after(wait, () => this.#settle());
  }

  // Decides what happens next from the state alone (also after restoring a saved game).
  #settle(): void {
    const { state, seats, you } = this.#view;
    if (state.phase === 'over') {
      this.#update({ waiting: 'over', movable: [] });
      if (!this.#reportedOver) {
        this.#reportedOver = true;
        const place = standings(state).findIndex((entry) => entry.seat === you) + 1;
        this.#options.onOver?.(place);
      }
      return;
    }
    const mine = state.current === you;
    if (state.phase === 'move') {
      // Restored in the middle of a move.
      this.#afterRoll();
      return;
    }
    if (mine) {
      this.#update({ waiting: 'you-roll', movable: [] });
      return;
    }
    if (seats[state.current] !== 'computer')
      throw new Error('only computer players take turns here');
    this.#update({ waiting: 'computer', movable: [] });
    this.#after(this.#pace.think, () => this.#roll());
  }

  #after(ms: number, run: () => void): void {
    if (this.#disposed) return;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#disposed) run();
    }, ms);
    this.#timers.add(timer);
  }

  #update(change: Partial<LudoView>): void {
    if (this.#disposed) return;
    this.#view = { ...this.#view, ...change };
    for (const listener of this.#listeners) listener();
  }
}
