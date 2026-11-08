// What wiping the phone does, in order (ADR 0022, 0036). Found on a vivo after "Delete
// account": the monthly backup reminder stayed scheduled and would have fired in 30 days.
import { describe, expect, it } from 'vitest';

import { runWipe, type WipeSteps } from './wipe-steps';

function steps(log: string[], failing?: keyof WipeSteps): WipeSteps {
  const step = (name: keyof WipeSteps) => () => {
    log.push(name);
    return name === failing ? Promise.reject(new Error(name)) : Promise.resolve();
  };
  return {
    resetCrypto: step('resetCrypto'),
    deleteDatabase: step('deleteDatabase'),
    deleteFiles: step('deleteFiles'),
    deleteSecrets: step('deleteSecrets'),
    clearNotifications: step('clearNotifications'),
    logout: step('logout'),
  };
}

describe('runWipe', () => {
  it('clears notifications (scheduled reminders, shown previews) before signing out', async () => {
    const log: string[] = [];
    await runWipe(steps(log));
    expect(log).toEqual([
      'resetCrypto',
      'deleteDatabase',
      'deleteFiles',
      'deleteSecrets',
      'clearNotifications',
      'logout',
    ]);
  });

  it('still signs out when a cleanup step fails', async () => {
    const log: string[] = [];
    await runWipe(steps(log, 'clearNotifications'));
    expect(log.at(-1)).toBe('logout');
  });
});
