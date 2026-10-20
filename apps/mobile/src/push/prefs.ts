// Notification settings (Settings → Notifications), kept in the encrypted local DB. They are not
// account settings: another phone of the same user can choose differently.
import { create } from 'zustand';

import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';

import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationPrefsSchema,
  type NotificationPrefs,
} from './content';

interface PrefsState {
  prefs: NotificationPrefs;
  loaded: boolean;
  load(): Promise<NotificationPrefs>;
  update(change: Partial<NotificationPrefs>): Promise<void>;
}

export const useNotificationPrefs = create<PrefsState>()((set, get) => ({
  prefs: DEFAULT_NOTIFICATION_PREFS,
  loaded: false,
  async load() {
    if (get().loaded) return get().prefs;
    const { db } = (await getCryptoContext()).database;
    const stored = await readSetting(db, SETTING_KEYS.notifications, NotificationPrefsSchema);
    const prefs = stored ?? DEFAULT_NOTIFICATION_PREFS;
    set({ prefs, loaded: true });
    return prefs;
  },
  async update(change) {
    const prefs = { ...(await get().load()), ...change };
    set({ prefs });
    const { db } = (await getCryptoContext()).database;
    await writeSetting(db, SETTING_KEYS.notifications, prefs);
  },
}));
