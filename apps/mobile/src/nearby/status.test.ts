import { describe, expect, it } from 'vitest';

import {
  BATTERY_EXEMPTION_COPY,
  describeNearby,
  NEARBY_COPY,
  nearbyStatus,
  needsBatteryExemption,
  needsLocation,
  pathLabel,
  type NearbyInputs,
} from './status';
import type { NearbyState } from '../../modules/nearby/src';

function native(overrides: Partial<NearbyState> = {}): NearbyState {
  return {
    supported: true,
    unsupportedReason: null,
    enabled: true,
    missingPermissions: [],
    running: true,
    advertising: true,
    scanning: true,
    autoConnect: true,
    rotationSeconds: 600,
    token: 'ab',
    foregroundService: true,
    le2MPhy: true,
    extendedAdvertising: true,
    multipleAdvertisement: true,
    sdk: 35,
    device: 'test',
    power: null,
    inboundQueued: 0,
    links: [],
    peers: [],
    ...overrides,
  };
}

const base: NearbyInputs = {
  available: true,
  enabled: true,
  native: native(),
  running: true,
  error: null,
  airplane: false,
  peers: 0,
};

describe('nearbyStatus', () => {
  it('says why it cannot run at all', () => {
    expect(nearbyStatus({ ...base, available: false })).toEqual({
      kind: 'unavailable',
      reason: 'not_in_build',
    });
    expect(
      nearbyStatus({
        ...base,
        native: native({ supported: false, unsupportedReason: 'android_too_old' }),
      }),
    ).toEqual({ kind: 'unavailable', reason: 'android_too_old' });
    expect(
      nearbyStatus({ ...base, native: native({ supported: false, unsupportedReason: 'x' }) }),
    ).toEqual({ kind: 'unavailable', reason: 'unsupported' });
  });

  it('shows the toggle first, then permission, then Bluetooth (REQ §19.4)', () => {
    expect(nearbyStatus({ ...base, enabled: false }).kind).toBe('off');
    const denied = native({
      missingPermissions: ['android.permission.BLUETOOTH_SCAN'],
      enabled: false,
    });
    expect(nearbyStatus({ ...base, native: denied })).toEqual({
      kind: 'permission',
      missing: ['android.permission.BLUETOOTH_SCAN'],
    });
    expect(nearbyStatus({ ...base, native: native({ enabled: false }), airplane: true })).toEqual({
      kind: 'bluetooth_off',
      airplane: true,
    });
  });

  it('reports a failed start, starting, and contacts in range', () => {
    expect(nearbyStatus({ ...base, running: false, error: 'permission' })).toEqual({
      kind: 'stopped',
      reason: 'permission',
    });
    expect(nearbyStatus({ ...base, running: false }).kind).toBe('starting');
    expect(nearbyStatus({ ...base, peers: 2 })).toEqual({ kind: 'on', peers: 2 });
  });
});

describe('describeNearby', () => {
  it('words every degraded state as something to do', () => {
    const airplane = describeNearby({ kind: 'bluetooth_off', airplane: true });
    expect(airplane.title).toContain('Airplane mode');
    expect(airplane.detail).toContain('Turn Bluetooth back on');
    expect(airplane.tone).toBe('warning');
    expect(describeNearby({ kind: 'bluetooth_off', airplane: false }).title).toBe(
      'Bluetooth is off',
    );
    expect(
      describeNearby({ kind: 'permission', missing: ['android.permission.BLUETOOTH_CONNECT'] })
        .title,
    ).toContain('Nearby devices');
    const location = describeNearby({
      kind: 'permission',
      missing: ['android.permission.ACCESS_FINE_LOCATION'],
    });
    expect(location.title).toContain('Location');
    expect(location.detail).toContain('does not use your location');
  });

  it('counts contacts nearby', () => {
    expect(describeNearby({ kind: 'on', peers: 0 }).title).toBe('On — no contacts nearby');
    expect(describeNearby({ kind: 'on', peers: 1 }).title).toBe('On — 1 contact nearby');
    expect(describeNearby({ kind: 'on', peers: 3 }).tone).toBe('success');
  });

  it('uses iOS words on an iPhone and promises no background mesh (ADR 0033)', () => {
    // The iOS module reports one missing permission, `bluetooth`.
    const permission = describeNearby({ kind: 'permission', missing: ['bluetooth'] }, 'ios');
    expect(permission.title).toBe('Needs Bluetooth access');
    expect(permission.detail).not.toContain('Nearby devices');
    expect(describeNearby({ kind: 'bluetooth_off', airplane: false }, 'ios').detail).toContain(
      'Control Center',
    );
    expect(describeNearby({ kind: 'on', peers: 0 }, 'ios').detail).toContain('Keep PingDost open');

    const ios = NEARBY_COPY.ios;
    for (const text of [ios.background, ios.relayBackground]) {
      expect(text).toMatch(/iOS (limits|may pause)/);
      expect(text).toContain('swipe');
      expect(text).not.toMatch(/always|continuous|guarantee/i);
    }
    expect(ios.relayBackground).toContain('None of this loses your own messages');
    expect(NEARBY_COPY.android.background).toContain('Nearby is on');
  });
});

describe('helpers', () => {
  it('knows when Android asks for location instead of Nearby devices', () => {
    expect(needsLocation(['android.permission.ACCESS_FINE_LOCATION'])).toBe(true);
    expect(needsLocation(['android.permission.BLUETOOTH_SCAN'])).toBe(false);
  });

  it('names the path of a delivery', () => {
    expect(pathLabel('nearby')).toContain('Bluetooth');
    expect(pathLabel('internet')).toContain('server');
    expect(pathLabel(undefined)).toBeNull();
  });

  it('asks for unrestricted battery use only on Android, while nearby is on and it is missing', () => {
    const power = (ignoring: boolean): NearbyState['power'] => ({
      batteryPercent: 80,
      charging: false,
      powerSave: false,
      deviceIdle: false,
      ignoringBatteryOptimizations: ignoring,
      interactive: false,
      importance: 125,
    });
    const optimized = native({ power: power(false) });
    expect(needsBatteryExemption('android', true, optimized)).toBe(true);
    expect(needsBatteryExemption('android', true, native({ power: power(true) }))).toBe(false);
    expect(needsBatteryExemption('android', false, optimized)).toBe(false);
    expect(needsBatteryExemption('ios', true, optimized)).toBe(false);
    // Unknown (no state yet): no nagging.
    expect(needsBatteryExemption('android', true, native())).toBe(false);
    expect(needsBatteryExemption('android', true, null)).toBe(false);
    expect(BATTERY_EXEMPTION_COPY.detail).toContain('Unrestricted');
  });
});
