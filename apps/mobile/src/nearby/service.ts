// Nearby messaging on this phone (Phase 22, ADR 0024): the BLE module (ADR 0023) under the
// message engine's `NearbyPeerTransport`, switched by the "Nearby messaging" toggle. The
// toggle is local to this phone and off until the user turns it on (Settings → Nearby
// messaging, which explains the permission first).
//
// While it is on and allowed, the phone advertises, scans and links to other PingDost phones,
// and a `connectedDevice` foreground service ("Nearby is on") keeps that going with the
// screen off. That service can only start while the app is on screen, so it is (re)started
// whenever the app comes to the foreground.
import * as Network from 'expo-network';
import { AppState, PermissionsAndroid, type Permission } from 'react-native';
import { z } from 'zod';
import { create } from 'zustand';

import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';
import {
  NearbyPeerTransport,
  type NearbyIdentity,
  type NearbySummary,
  type NearbyTransport,
} from '@pingdost/transport';

import { nearbyStatus, type NearbyStatus } from './status';
import {
  createBleTransport,
  PingdostNearby,
  type BleTransport,
  type NearbyState,
  type StartOptions,
} from '../../modules/nearby/src';

/** Discovery for messaging: find peers quickly, connect by itself (lower token connects). */
const START_OPTIONS: StartOptions = {
  autoConnect: true,
  advertise: true,
  scan: true,
  scanMode: 'balanced',
  advertiseInterval: 'medium',
};

const NearbyPrefsSchema = z.object({ enabled: z.boolean() });
export type NearbyPrefs = z.infer<typeof NearbyPrefsSchema>;

interface NearbyStore {
  enabled: boolean;
  loaded: boolean;
  native: NearbyState | null;
  summary: NearbySummary;
  running: boolean;
  error: string | null;
  airplane: boolean;
}

export const useNearby = create<NearbyStore>()(() => ({
  enabled: false,
  loaded: false,
  native: null,
  summary: { peers: [], unknown: 0, pending: 0 },
  running: false,
  error: null,
  airplane: false,
}));

/** The current state, as one value the screens switch on. */
export function useNearbyStatus(): NearbyStatus {
  return useNearby((state) =>
    nearbyStatus({
      available: PingdostNearby !== null,
      enabled: state.enabled,
      native: state.native,
      running: state.running,
      error: state.error,
      airplane: state.airplane,
      peers: state.summary.peers.length,
    }),
  );
}

/** Whether a contact's phone is linked and proved its key now (the chat header's "nearby"). */
export function useNearbyPeer(userId: string | undefined): boolean {
  return useNearby(
    (state) => userId !== undefined && state.summary.peers.some((p) => p.userId === userId),
  );
}

interface Running {
  transport: NearbyPeerTransport;
  ble: BleTransport;
  cleanup: (() => void)[];
}

let current: Running | undefined;
/** `apply` calls run one after another. */
let queue: Promise<void> = Promise.resolve();

async function loadPrefs(): Promise<NearbyPrefs> {
  const state = useNearby.getState();
  if (state.loaded) return { enabled: state.enabled };
  const { db } = (await getCryptoContext()).database;
  const stored = await readSetting(db, SETTING_KEYS.nearby, NearbyPrefsSchema);
  const prefs = stored ?? { enabled: false };
  useNearby.setState({ enabled: prefs.enabled, loaded: true });
  return prefs;
}

/** The native state and airplane mode, read again (e.g. back from the system settings). */
export async function refreshNearby(): Promise<NearbyState | null> {
  if (!PingdostNearby) return null;
  const [native, airplane] = await Promise.all([
    PingdostNearby.getState(),
    Network.isAirplaneModeEnabledAsync().catch(() => false),
  ]);
  useNearby.setState({ native, airplane });
  return native;
}

/**
 * The engine's nearby transport, or undefined in a build without the module. The chat runtime
 * makes it once per sign-in; `startNearby` then follows the toggle.
 */
export function createNearby(identity: NearbyIdentity): NearbyPeerTransport | undefined {
  const native = PingdostNearby;
  if (!native) return undefined;
  const ble = createBleTransport(native);
  const links: NearbyTransport = {
    ...ble,
    startDiscovery: () => ble.startDiscovery(START_OPTIONS),
  };
  const transport = new NearbyPeerTransport({
    links,
    identity,
    ...(__DEV__
      ? {
          log: (message: string, fields?: object) =>
            console.log(`[nearby] ${message}`, fields ?? ''),
        }
      : {}),
  });
  const stateChanged = native.addListener('stateChanged', (state) => {
    useNearby.setState({ native: state });
  });
  current = {
    transport,
    ble,
    cleanup: [
      transport.summary$.subscribe((summary) => useNearby.setState({ summary }), {
        emitCurrent: true,
      }),
      () => stateChanged.remove(),
    ],
  };
  return transport;
}

/** Starts or stops nearby messaging to match the toggle, the permissions and the hardware. */
export function startNearby(): Promise<void> {
  queue = queue.then(apply, apply);
  return queue;
}

async function apply(): Promise<void> {
  const running = current;
  const native = PingdostNearby;
  if (!running || !native) return;
  const { enabled } = await loadPrefs();
  const state = await refreshNearby().catch(() => null);
  const allowed = state !== null && state.supported && state.missingPermissions.length === 0;
  if (!enabled || !allowed) {
    await stopTransport(running);
    return;
  }
  if (running.transport.status$.value !== 'online') {
    try {
      await running.transport.start();
      useNearby.setState({ running: true, error: null });
    } catch (error) {
      useNearby.setState({ running: false, error: reasonOf(error) });
      return;
    }
  }
  if (AppState.currentState === 'active' && !state.foregroundService) {
    await native.startForegroundService().catch(() => undefined);
  }
}

async function stopTransport(running: Running): Promise<void> {
  if (running.transport.status$.value === 'online' || useNearby.getState().running) {
    await running.transport.stop().catch(() => undefined);
  }
  await PingdostNearby?.stopForegroundService().catch(() => undefined);
  useNearby.setState({ running: false, error: null });
}

/** The "Nearby messaging" toggle. */
export async function setNearbyEnabled(enabled: boolean): Promise<void> {
  await loadPrefs();
  useNearby.setState({ enabled });
  const { db } = (await getCryptoContext()).database;
  await writeSetting(db, SETTING_KEYS.nearby, { enabled } satisfies NearbyPrefs);
  await startNearby();
}

export type PermissionOutcome = 'granted' | 'denied' | 'blocked';

/** Asks for what the module reports missing; `blocked` means only the system settings can. */
export async function requestNearbyPermissions(): Promise<PermissionOutcome> {
  const state = await refreshNearby();
  const missing = (state?.missingPermissions ?? []) as Permission[];
  if (missing.length === 0) return 'granted';
  const results = Object.values(await PermissionsAndroid.requestMultiple(missing));
  await refreshNearby();
  if (results.every((result) => result === 'granted')) return 'granted';
  return results.includes('never_ask_again') ? 'blocked' : 'denied';
}

/** Stops nearby on sign-out: discovery, links and the foreground service. */
export async function disposeNearby(): Promise<void> {
  const running = current;
  current = undefined;
  if (!running) return;
  await queue.catch(() => undefined);
  await stopTransport(running);
  running.transport.dispose();
  running.ble.dispose();
  for (const remove of running.cleanup.splice(0)) remove();
  useNearby.setState({ summary: { peers: [], unknown: 0, pending: 0 }, loaded: false });
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'error';
}
