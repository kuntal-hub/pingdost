// How much history this browser asks the phone for (REQ §13.2, ADR 0021): the recent window
// in days, a per-browser choice kept in localStorage (default SYNC_RECENT_DAYS, 30). Older
// messages come per conversation on request ("Load older messages from phone").
import { DEFAULT_LIMITS } from '@pingdost/config/public';
import { DEFAULT_SYNC_WINDOW, type SyncWindow } from '@pingdost/message-engine';

export const SYNC_DAY_CHOICES = [7, 30, 90, 365] as const;
const KEY = 'pingdost.syncDays';

export function syncDays(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return (SYNC_DAY_CHOICES as readonly number[]).includes(value)
      ? value
      : DEFAULT_LIMITS.syncRecentDays;
  } catch {
    return DEFAULT_LIMITS.syncRecentDays;
  }
}

export function setSyncDays(days: number): void {
  try {
    localStorage.setItem(KEY, String(days));
  } catch {
    // Blocked storage: the default stays.
  }
}

export function syncWindow(): SyncWindow {
  return { ...DEFAULT_SYNC_WINDOW, days: syncDays() };
}
