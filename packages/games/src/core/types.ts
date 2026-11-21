// Shared game types (ADR 0049).

/** Every game PingDost knows; the catalog says which are playable in this build. */
export type GameId =
  | 'ludo'
  | 'tic-tac-toe'
  | 'connect-four'
  | 'dots-and-boxes'
  | 'snakes-and-ladders'
  | 'chess'
  | 'uno'
  | 'call-bridge'
  | 'poker';

/** Computer players' strength. They exist only in solo games. */
export type BotLevel = 'easy' | 'medium' | 'hard';
export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard'];

/**
 * Who plays a seat. `you`: this device's user. `computer`: a computer player (solo games only).
 * `friend`: another person, playing on their own device (games with friends, Phase 42).
 */
export type SeatKind = 'you' | 'computer' | 'friend';

/**
 * A game's rules, as every game module provides them. The generic parts (lobby, event log,
 * fair dice) build on this in Phase 42; each game adds its own move functions.
 */
export interface GameDefinition<State, Settings> {
  id: GameId;
  minPlayers: number;
  maxPlayers: number;
  defaultSettings: Settings;
  normalizeSettings(raw: unknown): Settings;
  /** The seat whose turn it is, or null when the game is over. */
  currentSeat(state: State): number | null;
  /** Seats best first once the game is over, else null. */
  result(state: State): number[] | null;
}
