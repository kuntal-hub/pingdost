// Settings → Backup (ADR 0022): when the last backup was made, and an optional monthly
// reminder as a local notification. Local to this phone; the phrase is never stored.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { z } from 'zod';
import { create } from 'zustand';

import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';
import { ensureChannels, MESSAGES_CHANNEL } from '@/push/notifications';

const BackupPrefsSchema = z.object({
  lastBackupAt: z.number().nullable(),
  /** The bytes of the last backup file. */
  lastBackupBytes: z.number().nullable(),
  reminder: z.boolean(),
});
export type BackupPrefs = z.infer<typeof BackupPrefsSchema>;

const DEFAULTS: BackupPrefs = { lastBackupAt: null, lastBackupBytes: null, reminder: false };
const REMINDER_ID = 'pingdost-backup-reminder';
export const REMINDER_DAYS = 30;

interface BackupPrefsState {
  prefs: BackupPrefs | null;
  load(): Promise<BackupPrefs>;
  update(change: Partial<BackupPrefs>): Promise<void>;
}

export const useBackupPrefs = create<BackupPrefsState>()((set, get) => ({
  prefs: null,
  async load() {
    const { db } = (await getCryptoContext()).database;
    const prefs = (await readSetting(db, SETTING_KEYS.backup, BackupPrefsSchema)) ?? DEFAULTS;
    set({ prefs });
    return prefs;
  },
  async update(change) {
    const current = get().prefs ?? (await get().load());
    const prefs = { ...current, ...change };
    const { db } = (await getCryptoContext()).database;
    await writeSetting(db, SETTING_KEYS.backup, prefs);
    set({ prefs });
    await scheduleReminder(prefs).catch(() => undefined);
  },
}));

/** One notification `REMINDER_DAYS` after the last backup (or from now, if none yet). */
async function scheduleReminder(prefs: BackupPrefs): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(REMINDER_ID).catch(() => undefined);
  if (!prefs.reminder) return;
  const from = prefs.lastBackupAt ?? Date.now();
  const date = new Date(Math.max(from + REMINDER_DAYS * 86_400_000, Date.now() + 60_000));
  await ensureChannels();
  await Notifications.scheduleNotificationAsync({
    identifier: REMINDER_ID,
    content: {
      title: 'Time for a PingDost backup',
      body: 'Your last backup is a month old. Open Settings → Backup to make a new one.',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
      ...(Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : {}),
    },
  });
}
