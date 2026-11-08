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

/**
 * Whether to ask for unrestricted battery use (Android, nearby on). Some phone makers freeze an
 * app with the screen off although its foreground service runs: a vivo V2437 (Android 16) froze
 * PingDost about 5 minutes after the screen went off, and every nearby packet went unanswered
 * until PingDost was exempt from battery optimization. Unknown power state: no prompt.
 */
export function needsBatteryExemption(
  platform: NearbyPlatform,
  enabled: boolean,
  native: NearbyState | null,
): boolean {
  return platform === 'android' && enabled && native?.power?.ignoringBatteryOptimizations === false;
}

export const BATTERY_EXEMPTION_COPY = {
  title: 'Keep it working with the screen off',
  detail:
    'Some phones pause PingDost when the screen is off, even with the “Nearby is on” notification, and nearby messages stop until you open it. Choose “Unrestricted” (or “Not optimized”) for PingDost.',
} as const;

export type NearbyPlatform = 'android' | 'ios';

/**
 * What each platform allows, said honestly (REQ §11.5, ADR 0023/0033). iOS gives an app far less
 * Bluetooth time in the background than Android's foreground service does, and nothing after a
 * swipe-away; the help must not promise more.
 */
export const NEARBY_COPY: Record<
  NearbyPlatform,
  {
    permissionName: string;
    setupIntro: string;
    background: string;
    relayBackground: string;
    blocked: string;
  }
> = {
  android: {
    permissionName: 'Nearby devices',
    setupIntro:
      'PingDost uses Bluetooth to find your contacts’ phones close by. Android calls this the “Nearby devices” permission. PingDost does not use your location.',
    background:
      'Android shows a “Nearby is on” notification while it runs. Battery savers, the phone maker’s power management, force-stopping the app or turning Bluetooth off pause it. It works best with PingDost open.',
    relayBackground:
      'Android shows “PingDost nearby relay active” while it relays. Relaying works best with PingDost open or recently used. It pauses or stops when you force-stop or swipe away the app on some phones, when a battery saver or the phone maker’s power management holds it back, when Bluetooth is off, and after the phone restarts until you open PingDost again. None of this loses your own messages: they wait on this phone.',
    blocked:
      'The permission is turned off for PingDost. Allow it in the app settings, then come back.',
  },
  ios: {
    permissionName: 'Bluetooth',
    setupIntro:
      'PingDost uses Bluetooth to find your contacts’ phones close by. iOS asks you to allow Bluetooth for PingDost. PingDost does not use your location.',
    background:
      'Nearby works fully while PingDost is open. In the background iOS limits Bluetooth: this iPhone can still reach phones that have PingDost open, but other phones may not find it, and links can pause. After you swipe PingDost away, nearby stops until you open it again.',
    relayBackground:
      'On an iPhone, relaying works while PingDost is open. iOS may pause it at any time while PingDost is in the background, shows no notice for it, and stops it when you swipe the app away or turn Bluetooth off. None of this loses your own messages: they wait on this phone.',
    blocked:
      'Bluetooth is turned off for PingDost. Allow it in Settings → PingDost, then come back.',
  },
};

export function describeNearby(
  status: NearbyStatus,
  platform: NearbyPlatform = 'android',
): NearbyText {
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
      if (platform === 'ios') {
        return {
          title: 'Needs Bluetooth access',
          detail:
            "Allow PingDost to use Bluetooth so it can find and connect to your contacts' phones.",
          tone: 'warning',
        };
      }
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
            detail:
              platform === 'ios'
                ? 'Turn on Bluetooth in Control Center or Settings to message contacts nearby.'
                : 'Turn on Bluetooth to message contacts nearby.',
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
            detail:
              platform === 'ios'
                ? "Messages wait on this phone until a contact's phone is in Bluetooth range. Keep PingDost open to be found by other phones."
                : "Messages wait on this phone until a contact's phone is in Bluetooth range.",
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
export function pathLabel(via: 'internet' | 'nearby' | 'mesh' | undefined): string | null {
  if (via === 'nearby') return 'Over Bluetooth, directly to this phone';
  if (via === 'internet') return 'Over the internet, through the server';
  if (via === 'mesh') return 'Over Bluetooth, through other phones nearby (relays)';
  return null;
}
