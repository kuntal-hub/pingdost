// A solo Ludo game: the user against 1–3 computer players (ADR 0049), saved on the device so
// it survives closing the app.
import { HOME, LUDO_COLORS, YARD, type LudoColor } from './board';
import {
  colorsFor,
  DEFAULT_LUDO_SETTINGS,
  normalizeLudoSettings,
  setupLudo,
  type LudoSettings,
  type LudoState,
} from './rules';
import { BOT_LEVELS, type BotLevel, type SeatKind } from '../core/types';

export interface LudoSoloOptions {
  you: LudoColor;
  /** Computer players: 1 to 3. */
  computers: number;
  level: BotLevel;
  settings: LudoSettings;
}

export interface LudoSoloGame {
  version: 1;
  game: 'ludo';
  options: LudoSoloOptions;
  /** Who plays each seat (index = `state.players` index). */
  seats: SeatKind[];
  state: LudoState;
  startedAt: number;
}

export const DEFAULT_LUDO_SOLO: LudoSoloOptions = {
  you: 'red',
  computers: 3,
  level: 'medium',
  settings: DEFAULT_LUDO_SETTINGS,
};

/** A new solo game; the user rolls first. */
export function createLudoSolo(options: LudoSoloOptions, now: number): LudoSoloGame {
  const computers = Math.min(3, Math.max(1, Math.floor(options.computers)));
  const colors = colorsFor(computers + 1, options.you);
  const state = setupLudo(colors, options.settings, options.you);
  return {
    version: 1,
    game: 'ludo',
    options: { ...options, computers },
    seats: state.players.map((player) => (player.color === options.you ? 'you' : 'computer')),
    state,
    startedAt: now,
  };
}

/** The last setup the user chose, read from storage. */
export function normalizeLudoSoloOptions(raw: unknown): LudoSoloOptions {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const you = LUDO_COLORS.includes(value.you as LudoColor) ? (value.you as LudoColor) : 'red';
  const computers =
    typeof value.computers === 'number' && [1, 2, 3].includes(value.computers)
      ? value.computers
      : 3;
  const level = BOT_LEVELS.includes(value.level as BotLevel) ? (value.level as BotLevel) : 'medium';
  return { you, computers, level, settings: normalizeLudoSettings(value.settings) };
}

/** A saved game read back, or null if it is not a playable Ludo game. */
export function restoreLudoSolo(raw: unknown): LudoSoloGame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const game = raw as Partial<LudoSoloGame>;
  if (game.version !== 1 || game.game !== 'ludo' || !game.state || !Array.isArray(game.seats)) {
    return null;
  }
  const state = game.state;
  const settings = normalizeLudoSettings(state.settings);
  const players = Array.isArray(state.players) ? state.players : [];
  if (players.length < 2 || players.length > 4 || game.seats.length !== players.length) return null;
  if (game.seats.filter((seat) => seat === 'you').length !== 1) return null;
  for (const player of players) {
    if (!LUDO_COLORS.includes(player.color)) return null;
    if (!Array.isArray(player.tokens) || player.tokens.length !== settings.tokens) return null;
    if (!player.tokens.every((p) => Number.isInteger(p) && p >= YARD && p <= HOME)) return null;
  }
  if (!Number.isInteger(state.current) || !players[state.current]) return null;
  if (state.phase !== 'roll' && state.phase !== 'move' && state.phase !== 'over') return null;
  if (
    state.phase === 'move' &&
    !(Number.isInteger(state.die) && state.die! >= 1 && state.die! <= 6)
  ) {
    return null;
  }
  return {
    version: 1,
    game: 'ludo',
    options: normalizeLudoSoloOptions(game.options),
    seats: game.seats.map((seat) => (seat === 'you' ? 'you' : 'computer')),
    state: { ...state, settings },
    startedAt: typeof game.startedAt === 'number' ? game.startedAt : 0,
  };
}
