// When this phone relays for others (ADR 0025; REQ §11.4), and how Settings says so.
import { describe, expect, it } from 'vitest';

import { DEFAULT_RELAY_PREFS, describeRelay, relayDecision, type RelayInputs } from './relay';

const power = (overrides = {}) => ({
  batteryPercent: 80,
  charging: false,
  powerSave: false,
  deviceIdle: false,
  ignoringBatteryOptimizations: false,
  interactive: true,
  importance: 100,
  ...overrides,
});

const inputs = (overrides: Partial<RelayInputs> = {}, prefs = {}): RelayInputs => ({
  prefs: { ...DEFAULT_RELAY_PREFS, enabled: true, ...prefs },
  nearbyRunning: true,
  power: power(),
  freeBytes: 10 * 1024 ** 3,
  ...overrides,
});

describe('relayDecision', () => {
  it('relays only when turned on and nearby runs', () => {
    expect(relayDecision(inputs())).toEqual({ relaying: true });
    expect(relayDecision(inputs({}, { enabled: false }))).toEqual({
      relaying: false,
      reason: 'off',
    });
    expect(relayDecision(inputs({ nearbyRunning: false }))).toEqual({
      relaying: false,
      reason: 'nearby_off',
    });
  });

  it('pauses on low battery (unless charging), saver, not charging and low storage', () => {
    expect(relayDecision(inputs({ power: power({ batteryPercent: 10 }) }))).toEqual({
      relaying: false,
      reason: 'battery_low',
    });
    expect(relayDecision(inputs({ power: power({ batteryPercent: 10, charging: true }) }))).toEqual(
      {
        relaying: true,
      },
    );
    expect(relayDecision(inputs({ power: power({ powerSave: true }) }))).toEqual({
      relaying: false,
      reason: 'saver',
    });
    expect(
      relayDecision(inputs({ power: power({ powerSave: true }) }, { pauseOnSaver: false })),
    ).toEqual({
      relaying: true,
    });
    expect(relayDecision(inputs({}, { onlyWhileCharging: true }))).toEqual({
      relaying: false,
      reason: 'not_charging',
    });
    expect(relayDecision(inputs({ freeBytes: 100 * 1_048_576 }))).toEqual({
      relaying: false,
      reason: 'storage_low',
    });
    // Unknown power or storage does not block it.
    expect(relayDecision(inputs({ power: null, freeBytes: null }))).toEqual({ relaying: true });
  });

  it('describes every state, with what is held', () => {
    const prefs = DEFAULT_RELAY_PREFS;
    expect(
      describeRelay({ relaying: true }, prefs, { packets: 2, bytes: 3_145_728 }).detail,
    ).toContain('2 encrypted messages for others (3.0 MB)');
    for (const reason of [
      'off',
      'nearby_off',
      'battery_low',
      'saver',
      'not_charging',
      'storage_low',
    ] as const) {
      expect(
        describeRelay({ relaying: false, reason }, prefs, { packets: 0, bytes: 0 }).title,
      ).not.toBe('');
    }
    expect(
      describeRelay({ relaying: false, reason: 'battery_low' }, prefs, { packets: 0, bytes: 0 })
        .title,
    ).toBe('Paused — battery low');
  });
});
