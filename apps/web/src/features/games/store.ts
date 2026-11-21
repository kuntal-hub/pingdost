// Games in this browser (ADR 0049): the last solo setup, the unfinished solo game, the stats and
// the auto-move preference, in localStorage like the appearance prefs. None of it is personal
// data and none of it leaves the browser.
import { create } from 'zustand';

import {
  createLudoSolo,
  DEFAULT_LUDO_SOLO,
  normalizeLudoSoloOptions,
  normalizeStats,
  recordResult,
  restoreLudoSolo,
  type BotLevel,
  type GameId,
  type LudoSoloGame,
  type LudoSoloOptions,
  type LudoState,
  type StatsBook,
} from '@pingdost/games';

const PREFS_KEY = 'pingdost.games';
const SOLO_KEY = 'pingdost.game-solo';

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
  autoMove: boolean;
  stats: StatsBook;
  /** The unfinished solo game, if any. */
  solo: LudoSoloGame | null;
  startSolo(options: LudoSoloOptions): LudoSoloGame;
  saveSoloState(state: LudoState): void;
  clearSolo(): void;
  setAutoMove(autoMove: boolean): void;
  record(game: GameId, mode: { solo: BotLevel } | 'friends', won: boolean): void;
}

function savePrefs(state: GamesState): void {
  write(PREFS_KEY, { ludoSetup: state.ludoSetup, autoMove: state.autoMove, stats: state.stats });
}

function initial(): Pick<GamesState, 'ludoSetup' | 'autoMove' | 'stats' | 'solo'> {
  const stored = read(PREFS_KEY);
  const prefs = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >;
  return {
    ludoSetup: prefs.ludoSetup ? normalizeLudoSoloOptions(prefs.ludoSetup) : DEFAULT_LUDO_SOLO,
    autoMove: typeof prefs.autoMove === 'boolean' ? prefs.autoMove : true,
    stats: normalizeStats(prefs.stats),
    solo: restoreLudoSolo(read(SOLO_KEY)),
  };
}

export const useGames = create<GamesState>()((set, get) => ({
  ...initial(),

  startSolo(options) {
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

  setAutoMove(autoMove) {
    set({ autoMove });
    savePrefs(get());
  },

  record(game, mode, won) {
    set({ stats: recordResult(get().stats, game, mode, won) });
    savePrefs(get());
  },
}));
