// Games on this phone (ADR 0049): the last solo setups, the unfinished solo games, the stats and
// the preferences. All in the encrypted local settings; nothing leaves the phone.
import { z } from 'zod';
import { create } from 'zustand';

import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';
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

const Stored = z.unknown();

type TurnSetups = Partial<Record<TurnGameId, TurnSoloOptions>>;
type TurnSolos = Partial<Record<TurnGameId, TurnSoloGame>>;

interface GamesState {
  loaded: boolean;
  ludoSetup: LudoSoloOptions;
  /** The last setup of each turn game (Phase 43). */
  turnSetups: TurnSetups;
  autoMove: boolean;
  /** Game sounds (ADR 0050), on by default. */
  sounds: boolean;
  stats: StatsBook;
  /** The unfinished solo Ludo game, if any. */
  solo: LudoSoloGame | null;
  /** The unfinished solo game of each turn game. */
  turnSolo: TurnSolos;
  load(): Promise<void>;
  /** Starts a new solo game with these options (replacing any saved one). */
  startSolo(options: LudoSoloOptions): LudoSoloGame;
  /** Saves the solo game's state after a roll or move. */
  saveSoloState(state: LudoState): void;
  /** Forgets the solo game (finished or abandoned). */
  clearSolo(): void;
  startTurnSolo(game: TurnGameId, options: TurnSoloOptions, first?: number): TurnSoloGame;
  /** Saves a solo turn game's state, if it is still the saved one. */
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
    turnSetups: state.turnSetups,
    autoMove: state.autoMove,
    sounds: state.sounds,
    stats: state.stats,
  };
}

function readTurnSetups(raw: unknown): TurnSetups {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: TurnSetups = {};
  for (const id of TURN_GAME_IDS) {
    if (value[id] !== undefined) out[id] = normalizeTurnSoloOptions(turnRules(id), value[id]);
  }
  return out;
}

function readTurnSolos(raw: unknown): TurnSolos {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: TurnSolos = {};
  for (const id of TURN_GAME_IDS) {
    const game = restoreTurnSolo(turnRules(id), value[id]);
    if (game) out[id] = game;
  }
  return out;
}

export const useGames = create<GamesState>()((set, get) => ({
  loaded: false,
  ludoSetup: DEFAULT_LUDO_SOLO,
  turnSetups: {},
  autoMove: true,
  sounds: true,
  stats: {},
  solo: null,
  turnSolo: {},

  async load() {
    if (get().loaded) return;
    const { db } = (await getCryptoContext()).database;
    const [prefs, solo, turnSolo] = await Promise.all([
      readSetting(db, SETTING_KEYS.games, Stored),
      readSetting(db, SETTING_KEYS.gameSolo, Stored),
      readSetting(db, SETTING_KEYS.gameTurnSolo, Stored),
    ]);
    const value = (typeof prefs === 'object' && prefs !== null ? prefs : {}) as Record<
      string,
      unknown
    >;
    set({
      loaded: true,
      ludoSetup: normalizeLudoSoloOptions(value.ludoSetup),
      turnSetups: readTurnSetups(value.turnSetups),
      autoMove: typeof value.autoMove === 'boolean' ? value.autoMove : true,
      sounds: typeof value.sounds === 'boolean' ? value.sounds : true,
      stats: normalizeStats(value.stats),
      solo: restoreLudoSolo(solo),
      turnSolo: readTurnSolos(turnSolo),
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

  startTurnSolo(game, options, first = 0) {
    const solo = createTurnSolo(turnRules(game), options, Date.now(), first);
    set({
      turnSolo: { ...get().turnSolo, [game]: solo },
      turnSetups: { ...get().turnSetups, [game]: solo.options },
    });
    persist(SETTING_KEYS.gameTurnSolo, get().turnSolo);
    persist(SETTING_KEYS.games, prefsOf(get()));
    return solo;
  },

  saveTurnState(game, startedAt, state) {
    const current = get().turnSolo[game];
    if (!current || current.startedAt !== startedAt) return;
    set({ turnSolo: { ...get().turnSolo, [game]: { ...current, state } } });
    persist(SETTING_KEYS.gameTurnSolo, get().turnSolo);
  },

  clearTurnSolo(game) {
    const next = { ...get().turnSolo };
    delete next[game];
    set({ turnSolo: next });
    persist(SETTING_KEYS.gameTurnSolo, next);
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
