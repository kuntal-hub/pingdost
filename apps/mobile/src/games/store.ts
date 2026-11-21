// Games on this phone (ADR 0049): the last solo setup, the unfinished solo game, the stats and
// the auto-move preference. All in the encrypted local settings; nothing leaves the phone.
import { z } from 'zod';
import { create } from 'zustand';

import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';
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

const Stored = z.unknown();

interface GamesState {
  loaded: boolean;
  ludoSetup: LudoSoloOptions;
  autoMove: boolean;
  /** Game sounds (ADR 0050), on by default. */
  sounds: boolean;
  stats: StatsBook;
  /** The unfinished solo game, if any. */
  solo: LudoSoloGame | null;
  load(): Promise<void>;
  /** Starts a new solo game with these options (replacing any saved one). */
  startSolo(options: LudoSoloOptions): LudoSoloGame;
  /** Saves the solo game's state after a roll or move. */
  saveSoloState(state: LudoState): void;
  /** Forgets the solo game (finished or abandoned). */
  clearSolo(): void;
  setAutoMove(autoMove: boolean): void;
  setSounds(sounds: boolean): void;
  record(game: GameId, mode: { solo: BotLevel } | 'friends', won: boolean): void;
}

// Writes go out one at a time, in order, so a later save never lands before an earlier one.
let queue: Promise<void> = Promise.resolve();
function persist(key: string, value: unknown): void {
  queue = queue
    .then(async () => {
      const { db } = (await getCryptoContext()).database;
      await writeSetting(db, key, value);
    })
    .catch(() => undefined);
}

function prefsOf(state: GamesState): unknown {
  return {
    ludoSetup: state.ludoSetup,
    autoMove: state.autoMove,
    sounds: state.sounds,
    stats: state.stats,
  };
}

export const useGames = create<GamesState>()((set, get) => ({
  loaded: false,
  ludoSetup: DEFAULT_LUDO_SOLO,
  autoMove: true,
  sounds: true,
  stats: {},
  solo: null,

  async load() {
    if (get().loaded) return;
    const { db } = (await getCryptoContext()).database;
    const [prefs, solo] = await Promise.all([
      readSetting(db, SETTING_KEYS.games, Stored),
      readSetting(db, SETTING_KEYS.gameSolo, Stored),
    ]);
    const value = (typeof prefs === 'object' && prefs !== null ? prefs : {}) as Record<
      string,
      unknown
    >;
    set({
      loaded: true,
      ludoSetup: normalizeLudoSoloOptions(value.ludoSetup),
      autoMove: typeof value.autoMove === 'boolean' ? value.autoMove : true,
      sounds: typeof value.sounds === 'boolean' ? value.sounds : true,
      stats: normalizeStats(value.stats),
      solo: restoreLudoSolo(solo),
    });
  },

  startSolo(options) {
    const solo = createLudoSolo(options, Date.now());
    set({ solo, ludoSetup: solo.options });
    persist(SETTING_KEYS.gameSolo, solo);
    persist(SETTING_KEYS.games, prefsOf(get()));
    return solo;
  },

  saveSoloState(state) {
    const current = get().solo;
    if (!current) return;
    const solo = { ...current, state };
    set({ solo });
    persist(SETTING_KEYS.gameSolo, solo);
  },

  clearSolo() {
    set({ solo: null });
    persist(SETTING_KEYS.gameSolo, null);
  },

  setAutoMove(autoMove) {
    set({ autoMove });
    persist(SETTING_KEYS.games, prefsOf(get()));
  },

  setSounds(sounds) {
    set({ sounds });
    persist(SETTING_KEYS.games, prefsOf(get()));
  },

  record(game, mode, won) {
    set({ stats: recordResult(get().stats, game, mode, won) });
    persist(SETTING_KEYS.games, prefsOf(get()));
  },
}));
