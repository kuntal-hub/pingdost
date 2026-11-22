// What every turn game's board gets from its screen (solo or with friends).
import type { TurnCore, TurnLast, TurnPace } from '@pingdost/games';

export interface TurnBoardProps<S extends TurnCore = TurnCore, M = unknown> {
  state: S;
  /** The user's seat (−1: watching). */
  you: number;
  /** The moves the user may make now (empty when it is not their turn). */
  legal: readonly M[];
  last: TurnLast<S, M> | null;
  onMove: (move: M) => void;
  /** The board's width; each board picks its own height. */
  size: number;
  dark: boolean;
  /** Motion is on (the user's Motion setting). */
  moves: boolean;
  pace: TurnPace;
  /** Each seat's name as the players' strip shows it ("You", a friend, "Computer 2"). */
  names?: (seat: number) => string;
}

/** A keyframe pop for a mark or box that just appeared. */
export const POP_IN = {
  '0%': { opacity: 0, transform: [{ scale: 0.3 }] },
  '70%': { opacity: 1, transform: [{ scale: 1.12 }] },
  '100%': { opacity: 1, transform: [{ scale: 1 }] },
};
