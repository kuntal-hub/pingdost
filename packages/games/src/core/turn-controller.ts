// Drives a solo turn game for a screen (ADR 0049): the user's moves and rolls, the computer
// players' turns, and pauses long enough to see each step. Platform-free: the apps subscribe
// with `useSyncExternalStore` and draw `view`. Every change is reported (`onState`) so the
// screen can save it.
import type { Random } from './random';
import {
  NORMAL_TURN_PACE,
  type TurnCore,
  type TurnPace,
  type TurnRules,
  type TurnStep,
  type TurnStepKind,
} from './turn';
import type { BotLevel, SeatKind } from './types';

/**
 * `you`: the user plays now. `rolling`: a die tumbles. `moving`: a step is shown. `them`:
 * someone else plays (a computer player thinking, or a friend). `over`: the game ended.
 */
export type TurnWaiting = 'you' | 'rolling' | 'moving' | 'them' | 'over';

export type TurnLast<S, M> = TurnStep<S, M> & { id: number };

export interface TurnView<S, M> {
  state: S;
  seats: readonly SeatKind[];
  /** The user's seat (−1: watching a game with friends). */
  you: number;
  waiting: TurnWaiting;
  /** The user's moves now (empty unless `waiting` is `you`; always empty in dice games). */
  legal: M[];
  /** The latest step, with a counter so the same step twice still animates. */
  last: TurnLast<S, M> | null;
}

export interface TurnControllerOptions<S extends TurnCore, M, Settings> {
  rules: TurnRules<S, M, Settings>;
  state: S;
  seats: readonly SeatKind[];
  level: BotLevel;
  random: Random;
  pace?: TurnPace;
  /** After every change of the state: save it. */
  onState?: (state: S) => void;
  /** Once, when the game ends while this controller runs: the user's place (1 = won). */
  onOver?: (place: number, state: S) => void;
}

export function stepDuration<S extends TurnCore, M>(
  rules: TurnRules<S, M, unknown>,
  step: TurnStep<S, M>,
  pace: TurnPace,
): number {
  return rules.stepMs?.(step, pace) ?? pace.step;
}

export class TurnController<S extends TurnCore, M, Settings> {
  #options: TurnControllerOptions<S, M, Settings>;
  #view: TurnView<S, M>;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #listeners = new Set<() => void>();
  #counter = 0;
  #disposed = false;
  #reportedOver: boolean;

  constructor(options: TurnControllerOptions<S, M, Settings>) {
    this.#options = options;
    const you = options.seats.indexOf('you');
    if (you < 0) throw new Error('a solo game needs the user in it');
    this.#reportedOver = options.state.ranks !== null;
    this.#view = {
      state: options.state,
      seats: options.seats,
      you,
      waiting: 'them',
      legal: [],
      last: null,
    };
    this.#next();
  }

  getView = (): TurnView<S, M> => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setPace(pace: TurnPace): void {
    this.#options = { ...this.#options, pace };
  }

  get #rules(): TurnRules<S, M, Settings> {
    return this.#options.rules;
  }

  get #pace(): TurnPace {
    return this.#options.pace ?? NORMAL_TURN_PACE;
  }

  /** The user's move. */
  move(move: M): void {
    const { state, waiting, you } = this.#view;
    if (waiting !== 'you' || this.#rules.dice || state.current !== you) return;
    if (!this.#rules.isLegal(state, move)) return;
    this.#show('move', you, state, this.#rules.apply(state, move), move);
  }

  /** The user's roll (dice games). */
  roll(): void {
    const { state, waiting, you } = this.#view;
    if (waiting !== 'you' || !this.#rules.dice || state.current !== you) return;
    this.#rollFor(you);
  }

  /** The user gives up (Chess): the game ends as if they had left. */
  resign(): void {
    const { state, you } = this.#view;
    if (state.ranks) return;
    this.#show('leave', you, state, this.#rules.leave(state, you));
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#listeners.clear();
  }

  #later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#disposed) run();
    }, ms);
    this.#timers.add(timer);
  }

  #set(change: Partial<TurnView<S, M>>): void {
    if (this.#disposed) return;
    this.#view = { ...this.#view, ...change };
    for (const listener of this.#listeners) listener();
  }

  #rollFor(seat: number): void {
    this.#set({ waiting: 'rolling', legal: [] });
    this.#later(this.#pace.roll, () => {
      const before = this.#view.state;
      const die = this.#options.random.die();
      this.#show('roll', seat, before, this.#rules.roll!(before, die), undefined, die);
    });
  }

  #show(kind: TurnStepKind, seat: number, before: S, state: S, move?: M, die?: number): void {
    const step: TurnStep<S, M> = { kind, seat, before, state };
    if (move !== undefined) step.move = move;
    if (die !== undefined) step.die = die;
    this.#set({ state, waiting: 'moving', legal: [], last: { ...step, id: ++this.#counter } });
    this.#options.onState?.(state);
    this.#later(stepDuration(this.#rules, step, this.#pace), () => this.#next());
  }

  #next(): void {
    const { state, you, seats } = this.#view;
    if (state.ranks) {
      this.#set({ waiting: 'over', legal: [] });
      if (!this.#reportedOver) {
        this.#reportedOver = true;
        this.#options.onOver?.(state.ranks[you]!, state);
      }
      return;
    }
    const auto = this.#rules.auto?.(state);
    if (auto !== undefined && auto !== null) {
      this.#set({ waiting: 'moving', legal: [] });
      this.#later(this.#pace.read, () => {
        if (this.#view.state !== state) return;
        this.#show('move', state.current, state, this.#rules.apply(state, auto), auto);
      });
      return;
    }
    const seat = state.current;
    if (seats[seat] === 'you') {
      this.#set({ waiting: 'you', legal: this.#rules.dice ? [] : this.#rules.legal(state) });
      return;
    }
    this.#set({ waiting: 'them', legal: [] });
    this.#later(this.#pace.think, () => {
      if (this.#view.state !== state) return;
      if (this.#rules.dice) {
        this.#rollFor(seat);
        return;
      }
      const chosen = this.#rules.bot(state, this.#options.level, this.#options.random);
      const play = (move: M) => {
        if (this.#disposed || this.#view.state !== state) return;
        this.#show('move', seat, state, this.#rules.apply(state, move), move);
      };
      if (chosen instanceof Promise) void chosen.then(play);
      else play(chosen);
    });
  }
}
