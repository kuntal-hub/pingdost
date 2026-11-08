// When the monthly backup reminder fires (ADR 0022). Pure, so it is unit-tested; scheduling
// and firing are the notification library's (`prefs.ts`).
export const REMINDER_DAYS = 30;

/** `REMINDER_DAYS` after the last backup (or after `now` without one), but never in the past. */
export function reminderDate(lastBackupAt: number | null, now: number): Date {
  const from = lastBackupAt ?? now;
  return new Date(Math.max(from + REMINDER_DAYS * 86_400_000, now + 60_000));
}
