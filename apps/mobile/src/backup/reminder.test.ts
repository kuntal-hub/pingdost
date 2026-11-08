// When the monthly backup reminder fires (ADR 0022): 30 days after the last backup, never in
// the past, and 30 days from now when there is no backup yet.
import { describe, expect, it } from 'vitest';

import { REMINDER_DAYS, reminderDate } from './reminder';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9, 12);

describe('reminderDate', () => {
  it('is 30 days after the last backup', () => {
    expect(REMINDER_DAYS).toBe(30);
    expect(reminderDate(NOW - 10 * DAY, NOW).getTime()).toBe(NOW + 20 * DAY);
  });

  it('is a minute from now when the last backup is already older than that', () => {
    expect(reminderDate(NOW - 45 * DAY, NOW).getTime()).toBe(NOW + 60_000);
  });

  it('counts from now when there is no backup yet', () => {
    expect(reminderDate(null, NOW).getTime()).toBe(NOW + 30 * DAY);
  });
});
