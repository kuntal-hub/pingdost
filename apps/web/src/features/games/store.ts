// Games in this browser (ADR 0049): the last solo setups, the unfinished solo games, the stats
// and the preferences, in localStorage like the appearance prefs. None of it is personal data and
// none of it leaves the browser.
import { create } from 'zustand';

import {
  createLudoSolo,
  createTurnSolo,
  DEFAULT_LUDO_SOLO,
  defaultTurnSoloOptions,
  normalizeLudoSoloOptions,
  normalizeStats,
  normalizeTurnSoloOptions,
  recordResult,
  restoreLudoSolo,
  restoreTurnSolo,
  TURN_GAME_IDS,
  turnRules,
  type BotLevel,
  type GameId,
  type LudoSoloGame,
  type LudoSoloOptions,
  type LudoState,
  type StatsBook,
  type TurnCore,
  type TurnGameId,
  type TurnSoloGame,
  type TurnSoloOptions,
} from '@pingdost/games';

const PREFS_KEY = 'pingdost.games';
const SOLO_KEY = 'pingdost.game-solo';
/** Unfinished solo turn games (Phase 43), one per game. */
const TURN_SOLO_KEY = 'pingdost.game-turn-solo';

type TurnSetups = Partial<Record<TurnGameId, TurnSoloOptions>>;
type TurnSolos = Partial<Record<TurnGameId, TurnSoloGame>>;

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A private window or blocked storage: it just will not be remembered.
  }
}

interface GamesState {
  ludoSetup: LudoSoloOptions;
  turnSetups: TurnSetups;
  autoMove: boolean;
  /** Game sounds (ADR 0050), on by default. */
  sounds: boolean;
  stats: StatsBook;
  /** The unfinished solo Ludo game, if any. */
  solo: LudoSoloGame | null;
  turnSolo: TurnSolos;
  startSolo(options: LudoSoloOptions): LudoSoloGame;
  saveSoloState(state: LudoState): void;
  clearSolo(): void;
  startTurnSolo(game: TurnGameId, options: TurnSoloOptions, first?: number): TurnSoloGame;
  saveTurnState(game: TurnGameId, startedAt: number, state: TurnCore): void;
  clearTurnSolo(game: TurnGameId): void;
  setAutoMove(autoMove: boolean): void;
  setSounds(sounds: boolean): void;
  record(game: GameId, mode: { solo: BotLevel } | 'friends', won: boolean): void;
}

/** The setup to show for a turn game: the last one used, else the defaults. */
export function turnSetupOf(state: Pick<GamesState, 'turnSetups'>, game: TurnGameId) {
  return state.turnSetups[game] ?? defaultTurnSoloOptions(turnRules(game));
}

function savePrefs(state: GamesState): void {
  write(PREFS_KEY, {
    ludoSetup: state.ludoSetup,
    turnSetups: state.turnSetups,
    autoMove: state.autoMove,
    sounds: state.sounds,
    stats: state.stats,
  });
}

function objectOf(raw: unknown): Record<string, unknown> {
  return (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
}

function initial(): Pick<
  GamesState,
  'ludoSetup' | 'turnSetups' | 'autoMove' | 'sounds' | 'stats' | 'solo' | 'turnSolo'
> {
  const prefs = objectOf(read(PREFS_KEY));
  const setups = objectOf(prefs.turnSetups);
  const saved = objectOf(read(TURN_SOLO_KEY));
  const turnSetups: TurnSetups = {};
  const turnSolo: TurnSolos = {};
  for (const id of TURN_GAME_IDS) {
    if (setups[id] !== undefined)
      turnSetups[id] = normalizeTurnSoloOptions(turnRules(id), setups[id]);
    const game = restoreTurnSolo(turnRules(id), saved[id]);
    if (game) turnSolo[id] = game;
  }
  return {
    ludoSetup: prefs.ludoSetup ? normalizeLudoSoloOptions(prefs.ludoSetup) : DEFAULT_LUDO_SOLO,
    turnSetups,
    autoMove: typeof prefs.autoMove === 'boolean' ? prefs.autoMove : true,
    sounds: typeof prefs.sounds === 'boolean' ? prefs.sounds : true,
    stats: normalizeStats(prefs.stats),
    solo: restoreLudoSolo(read(SOLO_KEY)),
    turnSolo,
  };
}

export const useGames = create<GamesState>()((set, get) => ({
  ...initial(),

  startSolo(options) {
    // Replacing an unfinished game quits it: a loss.
    const replaced = get().solo;
    if (replaced && replaced.state.phase !== 'over') {
      get().record('ludo', { solo: replaced.options.level }, false);
    }
    const solo = createLudoSolo(options, Date.now());
    set({ solo, ludoSetup: solo.options });
    write(SOLO_KEY, solo);
    savePrefs(get());
    return solo;
  },

  saveSoloState(state) {
    const current = get().solo;
    if (!current) return;
    const solo = { ...current, state };
    set({ solo });
    write(SOLO_KEY, solo);
  },

  clearSolo() {
    set({ solo: null });
    write(SOLO_KEY, null);
  },

  startTurnSolo(game, options, first = 0) {
    const replaced = get().turnSolo[game];
    if (replaced && replaced.state.ranks === null) {
      get().record(game, { solo: replaced.options.level }, false);
    }
    const solo = createTurnSolo(turnRules(game), options, Date.now(), first);
    set({
      turnSolo: { ...get().turnSolo, [game]: solo },
      turnSetups: { ...get().turnSetups, [game]: solo.options },
    });
    write(TURN_SOLO_KEY, get().turnSolo);
    savePrefs(get());
    return solo;
  },

  saveTurnState(game, startedAt, state) {
    const current = get().turnSolo[game];
    if (!current || current.startedAt !== startedAt) return;
    set({ turnSolo: { ...get().turnSolo, [game]: { ...current, state } } });
    write(TURN_SOLO_KEY, get().turnSolo);
  },

  clearTurnSolo(game) {
    const next = { ...get().turnSolo };
    delete next[game];
    set({ turnSolo: next });
    write(TURN_SOLO_KEY, next);
  },

  setAutoMove(autoMove) {
    set({ autoMove });
    savePrefs(get());
  },

  setSounds(sounds) {
    set({ sounds });
    savePrefs(get());
  },

  record(game, mode, won) {
    set({ stats: recordResult(get().stats, game, mode, won) });
    savePrefs(get());
  },
}));
