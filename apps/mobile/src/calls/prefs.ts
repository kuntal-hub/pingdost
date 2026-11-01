// Call settings on this phone (ADR 0029), in the encrypted local DB: "Force relay (TURN)", a
// debug switch that sends every call through the relay server.
import { z } from 'zod';
import { create } from 'zustand';

import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';

export const CallPrefsSchema = z.object({ forceRelay: z.boolean() });
export type CallPrefs = z.infer<typeof CallPrefsSchema>;

const DEFAULT_CALL_PREFS: CallPrefs = { forceRelay: false };

interface CallPrefsState {
  prefs: CallPrefs;
  loaded: boolean;
  load(): Promise<CallPrefs>;
  update(change: Partial<CallPrefs>): Promise<void>;
}

export const useCallPrefs = create<CallPrefsState>()((set, get) => ({
  prefs: DEFAULT_CALL_PREFS,
  loaded: false,
  async load() {
    if (get().loaded) return get().prefs;
    const { db } = (await getCryptoContext()).database;
    const prefs =
      (await readSetting(db, SETTING_KEYS.calls, CallPrefsSchema)) ?? DEFAULT_CALL_PREFS;
    set({ prefs, loaded: true });
    return prefs;
  },
  async update(change) {
    const prefs = { ...(await get().load()), ...change };
    set({ prefs });
    const { db } = (await getCryptoContext()).database;
    await writeSetting(db, SETTING_KEYS.calls, prefs);
  },
}));
