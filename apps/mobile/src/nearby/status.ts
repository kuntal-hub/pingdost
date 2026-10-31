// What nearby messaging can do right now, and how to say it (REQ §11.6, §19.4: degraded states
// are shown, never silent). Pure, so every state is unit-tested.
import type { NearbyState } from '../../modules/nearby/src';

export type NearbyStatus =
  | { kind: 'unavailable'; reason: 'not_in_build' | 'android_too_old' | 'no_ble' | 'unsupported' }
  | { kind: 'off' }
  | { kind: 'permission'; missing: string[] }
  | { kind: 'bluetooth_off'; airplane: boolean }
  | { kind: 'starting' }
  | { kind: 'stopped'; reason: string }
  | { kind: 'on'; peers: number };

export interface NearbyInputs {
  /** The native module is in this build. */
  available: boolean;
  /** The "Nearby messaging" toggle. */
  enabled: boolean;
  native: NearbyState | null;
  /** The nearby transport is looking for peers. */
  running: boolean;
  /** Why the last start failed. */
  error: string | null;
  airplane: boolean;
  /** Known contacts' phones with a link now. */
  peers: number;
}

export function nearbyStatus(input: NearbyInputs): NearbyStatus {
  const { native } = input;
  if (!input.available) return { kind: 'unavailable', reason: 'not_in_build' };
  if (native && !native.supported) {
    const reason = native.unsupportedReason;
    return {
      kind: 'unavailable',
      reason: reason === 'android_too_old' || reason === 'no_ble' ? reason : 'unsupported',
    };
  }
  if (!input.enabled) return { kind: 'off' };
  if (native && native.missingPermissions.length > 0) {
    return { kind: 'permission', missing: native.missingPermissions };
  }
  if (native && !native.enabled) return { kind: 'bluetooth_off', airplane: input.airplane };
  if (input.error) return { kind: 'stopped', reason: input.error };
  if (!input.running) return { kind: 'starting' };
  return { kind: 'on', peers: input.peers };
}

export interface NearbyText {
  title: string;
  detail: string;
  /** `warning`: on, but cannot work until the user acts. */
  tone: 'muted' | 'warning' | 'success';
}

/** Android 8–11 ask for location to scan for Bluetooth devices; 12+ for "Nearby devices". */
export function needsLocation(missing: readonly string[]): boolean {
  return missing.some((name) => name.endsWith('ACCESS_FINE_LOCATION'));
}

export function describeNearby(status: NearbyStatus): NearbyText {
  switch (status.kind) {
    case 'unavailable':
      return {
        title: 'Not available on this phone',
        detail:
          status.reason === 'not_in_build'
            ? 'This version of PingDost was built without nearby messaging. Update the app.'
            : status.reason === 'android_too_old'
              ? 'Nearby messaging needs Android 8.0 or newer.'
              : status.reason === 'no_ble'
                ? 'This phone has no Bluetooth Low Energy.'
                : 'This phone cannot run nearby messaging.',
        tone: 'muted',
      };
    case 'off':
      return {
        title: 'Off',
        detail: 'Turn on to message contacts whose phones are near you when there is no internet.',
        tone: 'muted',
      };
    case 'permission':
      return needsLocation(status.missing)
        ? {
            title: 'Needs the Location permission',
            detail:
              'On this Android version, finding Bluetooth devices needs the Location permission and location turned on. PingDost does not use your location.',
            tone: 'warning',
          }
        : {
            title: 'Needs the Nearby devices permission',
            detail: "Allow it so PingDost can find and connect to your contacts' phones.",
            tone: 'warning',
          };
    case 'bluetooth_off':
      return status.airplane
        ? {
            title: 'Airplane mode: Bluetooth is off',
            detail: 'Turn Bluetooth back on to message contacts nearby. Airplane mode can stay on.',
            tone: 'warning',
          }
        : {
            title: 'Bluetooth is off',
            detail: 'Turn on Bluetooth to message contacts nearby.',
            tone: 'warning',
          };
    case 'starting':
      return { title: 'Starting…', detail: 'Turning on Bluetooth discovery.', tone: 'muted' };
    case 'stopped':
      return {
        title: 'Stopped',
        detail: `Nearby messaging could not start (${status.reason}). Turn it off and on again.`,
        tone: 'warning',
      };
    case 'on':
      return status.peers === 0
        ? {
            title: 'On — no contacts nearby',
            detail: "Messages wait on this phone until a contact's phone is in Bluetooth range.",
            tone: 'muted',
          }
        : {
            title: `On — ${status.peers === 1 ? '1 contact' : `${status.peers} contacts`} nearby`,
            detail: 'Without internet, messages to them go directly over Bluetooth.',
            tone: 'success',
          };
  }
}

/** The path a delivery took, for message info. */
export function pathLabel(via: 'internet' | 'nearby' | undefined): string | null {
  if (via === 'nearby') return 'Over Bluetooth, directly to this phone';
  if (via === 'internet') return 'Over the internet, through the server';
  return null;
}
