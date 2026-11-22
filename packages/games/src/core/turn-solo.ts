// A solo turn game: the user (seat 0) against computer players (ADR 0049: only when playing
// alone), saved on the device so it survives closing the app.
import { cryptoRandom, type Random } from './random';
import type { AnyTurnRules, TurnCore, TurnGameId } from './turn';
import { BOT_LEVELS, type BotLevel, type SeatKind } from './types';

export interface TurnSoloOptions {
  /** Computer players: 1 to the game's maximum − 1. */
  computers: number;
  /** Ignored by games without levels (Snakes and Ladders). */
  level: BotLevel;
  settings: unknown;
}

export interface TurnSoloGame {
  version: 1;
  game: TurnGameId;
  options: TurnSoloOptions;
  /** Who plays each seat: the user is seat 0. */
  seats: SeatKind[];
  /** The seat that moved first (Play again lets the other side start). */
  first: number;
  state: TurnCore;
  startedAt: number;
}

export function defaultTurnSoloOptions(rules: AnyTurnRules): TurnSoloOptions {
  return { computers: 1, level: 'medium', settings: rules.defaultSettings };
}

export function normalizeTurnSoloOptions(rules: AnyTurnRules, raw: unknown): TurnSoloOptions {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const most = rules.maxPlayers - 1;
  const computers =
    typeof value.computers === 'number' && Number.isInteger(value.computers)
      ? Math.min(most, Math.max(1, value.computers))
      : 1;
  const level = BOT_LEVELS.includes(value.level as BotLevel) ? (value.level as BotLevel) : 'medium';
  return { computers, level, settings: rules.normalizeSettings(value.settings) };
}

/** A new solo game; `first` moves first (Chess: the user's chosen side decides). */
export function createTurnSolo(
  rules: AnyTurnRules,
  options: TurnSoloOptions,
  now: number,
  first = 0,
  random: Random = cryptoRandom(),
): TurnSoloGame {
  const normalized = normalizeTurnSoloOptions(rules, options);
  const count = normalized.computers + 1;
  const starter = rules.firstSeat?.(normalized.settings, first % count, 0, count) ?? first % count;
  return {
    version: 1,
    game: rules.id,
    options: normalized,
    seats: Array.from({ length: count }, (_, i) => (i === 0 ? 'you' : 'computer')),
    first: first % count,
    state: ((s) => (rules.soloSetup ? rules.soloSetup(s, random) : s))(
      rules.setup(count, normalized.settings, starter),
    ),
    startedAt: now,
  };
}

/** A saved game read back, or null if it is not a playable game of this kind. */
export function restoreTurnSolo(rules: AnyTurnRules, raw: unknown): TurnSoloGame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const game = raw as Partial<TurnSoloGame>;
  if (game.version !== 1 || game.game !== rules.id || !Array.isArray(game.seats)) return null;
  const state = rules.restore(game.state);
  if (!state || game.seats.length !== state.seats || game.seats[0] !== 'you') return null;
  return {
    version: 1,
    game: rules.id,
    options: normalizeTurnSoloOptions(rules, game.options),
    seats: game.seats.map((_, i) => (i === 0 ? 'you' : 'computer')),
    first: Number.isInteger(game.first) ? game.first! % state.seats : 0,
    state,
    startedAt: typeof game.startedAt === 'number' ? game.startedAt : 0,
  };
}
