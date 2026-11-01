// JSON values in the encrypted `local_settings` table. Rows that no longer match their schema
// read as missing.
import type { SQLiteDatabase } from 'expo-sqlite';
import type { z } from 'zod';

export const SETTING_KEYS = {
  /** `LocalDevice`: this phone's device ID and the account it is registered to. */
  device: 'device',
  /** `PrivacyPrefs`, cached for offline use. */
  privacy: 'privacy',
  /** The users this account blocked (`{ userId, ids }`), cached for offline use. */
  blocks: 'blocks',
  /** `NotificationPrefs` (Settings → Notifications); local to this phone. */
  notifications: 'notifications',
  /** `AttachmentPrefs` (Settings → Storage): automatic downloads; local to this phone. */
  attachments: 'attachments',
  /** `BackupPrefs` (Settings → Backup): last backup time and the reminder (ADR 0022). */
  backup: 'backup',
  /** Contacts to tell about this new phone once the chat engine runs (after a restore). */
  announce: 'announce',
  /** `NearbyPrefs` (Settings → Nearby messaging): local to this phone (ADR 0024). */
  nearby: 'nearby',
  /** `RelayPrefs` (Settings → Nearby relay): local to this phone, off by default (ADR 0025). */
  relay: 'relay',
} as const;

export async function readSetting<T>(
  db: SQLiteDatabase,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM local_settings WHERE key = ?',
    [key],
  );
  if (!row) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeSetting(db: SQLiteDatabase, key: string, value: unknown): Promise<void> {
  await db.runAsync(
    `INSERT INTO local_settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}
