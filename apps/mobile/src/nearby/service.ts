// Nearby messaging on this phone (Phase 22, ADR 0024): the BLE module (ADR 0023) under the
// message engine's `NearbyPeerTransport`, switched by the "Nearby messaging" toggle. The
// toggle is local to this phone and off until the user turns it on (Settings → Nearby
// messaging, which explains the permission first).
//
// While it is on and allowed, the phone advertises, scans and links to other PingDost phones,
// and a `connectedDevice` foreground service ("Nearby is on") keeps that going with the
// screen off. That service can only start while the app is on screen, so it is (re)started
// whenever the app comes to the foreground.
//
// The mesh relay (Phase 23, ADR 0025) rides on the same links: messages for contacts out of
// range wait in it for relays, and with "Nearby relay" on (Settings, off by default) this
// phone also carries other people's encrypted messages, paused by the battery and storage
// rules in `relay.ts`. The service's notification then says "PingDost nearby relay active".
import { Paths } from 'expo-file-system';
import * as Network from 'expo-network';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useMemo } from 'react';
import { AppState, PermissionsAndroid, Platform, type Permission } from 'react-native';
import { z } from 'zod';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';
import {
  NearbyPeerTransport,
  type MeshStatus,
  type NearbyIdentity,
  type NearbySummary,
  type NearbyTransport,
} from '@pingdost/transport';

import { meshFileSink } from './files';
import {
  DEFAULT_RELAY_PREFS,
  relayDecision,
  RelayPrefsSchema,
  type RelayDecision,
  type RelayPrefs,
} from './relay';
import { SqliteMeshPersistence } from './relay-store';
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

const NearbyPrefsSchema = z.object({
  enabled: z.boolean(),
  /** Largest file sent over nearby without the Internet, MB (ADR 0027). */
  fileMaxMb: z.number().int().positive().optional(),
});

/** Default largest file over nearby: BLE moves about 50–150 KB/s (ADR 0023, 0027). */
export const DEFAULT_MESH_FILE_MAX_MB = 25;
export type NearbyPrefs = z.infer<typeof NearbyPrefsSchema>;

interface NearbyStore {
  enabled: boolean;
  /** Largest file over nearby, MB. */
  fileMaxMb: number;
  loaded: boolean;
  native: NearbyState | null;
  summary: NearbySummary;
  running: boolean;
  error: string | null;
  airplane: boolean;
  /** Settings → Nearby relay (ADR 0025). */
  relay: RelayPrefs;
  relayDecision: RelayDecision;
  /** The relay's counters and store, while signed in on a build with the module. */
  mesh: MeshStatus | null;
}

const EMPTY_MESH: MeshStatus = {
  relaying: false,
  stored: { packets: 0, bytes: 0 },
  own: 0,
  carried: 0,
  handedOver: 0,
  files: 0,
};

export const useNearby = create<NearbyStore>()(() => ({
  enabled: false,
  fileMaxMb: DEFAULT_MESH_FILE_MAX_MB,
  loaded: false,
  native: null,
  summary: { peers: [], unknown: 0, pending: 0 },
  running: false,
  error: null,
  airplane: false,
  relay: DEFAULT_RELAY_PREFS,
  relayDecision: { relaying: false, reason: 'off' },
  mesh: null,
}));

/** The relay's state for Settings and Storage. */
export function useRelay(): {
  prefs: RelayPrefs;
  decision: RelayDecision;
  mesh: MeshStatus;
  available: boolean;
} {
  const prefs = useNearby((state) => state.relay);
  const decision = useNearby((state) => state.relayDecision);
  const mesh = useNearby((state) => state.mesh);
  return { prefs, decision, mesh: mesh ?? EMPTY_MESH, available: mesh !== null };
}

/** The current state, as one value the screens switch on. */
export function useNearbyStatus(): NearbyStatus {
  // The inputs, compared shallowly, then the status from them: a selector that built a new
  // object on every call made zustand re-render without end ("Maximum update depth").
  const inputs = useNearby(
    useShallow((state) => ({
      enabled: state.enabled,
      native: state.native,
      running: state.running,
      error: state.error,
      airplane: state.airplane,
      peers: state.summary.peers.length,
    })),
  );
  return useMemo(() => nearbyStatus({ available: PingdostNearby !== null, ...inputs }), [inputs]);
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
  if (state.loaded) return { enabled: state.enabled, fileMaxMb: state.fileMaxMb };
  const { db } = (await getCryptoContext()).database;
  const stored = await readSetting(db, SETTING_KEYS.nearby, NearbyPrefsSchema);
  const relay = await readSetting(db, SETTING_KEYS.relay, RelayPrefsSchema);
  const prefs = stored ?? { enabled: false };
  useNearby.setState({
    enabled: prefs.enabled,
    fileMaxMb: prefs.fileMaxMb ?? DEFAULT_MESH_FILE_MAX_MB,
    relay: relay ?? DEFAULT_RELAY_PREFS,
    loaded: true,
  });
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

/** Battery and storage change slowly: the relay rules are checked again this often. */
const RELAY_CHECK_MS = 60_000;

/**
 * The engine's nearby transport, or undefined in a build without the module. The chat runtime
 * makes it once per sign-in; `startNearby` then follows the toggle. The mesh relay's store is
 * this phone's database (`mesh_relay_packets`, apart from chats).
 */
export function createNearby(
  identity: NearbyIdentity,
  db: SQLiteDatabase,
): NearbyPeerTransport | undefined {
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
    // Files over the mesh come to `meshFileSink` (ADR 0027).
    mesh: { persistence: new SqliteMeshPersistence(db), relaying: false, files: meshFileSink },
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
  const check = setInterval(() => void startNearby().catch(() => undefined), RELAY_CHECK_MS);
  current = {
    transport,
    ble,
    cleanup: [
      transport.summary$.subscribe((summary) => useNearby.setState({ summary }), {
        emitCurrent: true,
      }),
      ...(transport.mesh
        ? [
            transport.mesh.status$.subscribe((mesh) => useNearby.setState({ mesh }), {
              emitCurrent: true,
            }),
          ]
        : []),
      () => stateChanged.remove(),
      () => clearInterval(check),
    ],
  };
  return transport;
}

function freeBytes(): number | null {
  try {
    const free = Paths.availableDiskSpace;
    return Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    return null;
  }
}

/** Relaying follows the toggle, nearby itself, the battery and the storage, at once. */
function applyRelay(running: Running, nearbyRunning: boolean): void {
  const { relay, native } = useNearby.getState();
  const decision = relayDecision({
    prefs: relay,
    nearbyRunning,
    power: native?.power ?? null,
    freeBytes: freeBytes(),
  });
  useNearby.setState({ relayDecision: decision });
  running.transport.mesh?.setRelaying(decision.relaying);
  PingdostNearby?.setRelayNotification?.(decision.relaying);
  PingdostNearby?.setRestartReminder?.(relay.remindAfterRestart && useNearby.getState().enabled);
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
    applyRelay(running, false);
    await stopTransport(running);
    return;
  }
  if (running.transport.status$.value !== 'online') {
    try {
      await running.transport.start();
      useNearby.setState({ running: true, error: null });
    } catch (error) {
      useNearby.setState({ running: false, error: reasonOf(error) });
      applyRelay(running, false);
      return;
    }
  }
  applyRelay(running, true);
  if (AppState.currentState === 'active' && !state.foregroundService) {
    await native.startForegroundService().catch(() => undefined);
  }
}

/** Settings → Nearby messaging: the largest file sent over nearby without the Internet. */
export async function setMeshFileLimit(fileMaxMb: number): Promise<void> {
  await loadPrefs();
  useNearby.setState({ fileMaxMb });
  const { db } = (await getCryptoContext()).database;
  await writeSetting(db, SETTING_KEYS.nearby, {
    enabled: useNearby.getState().enabled,
    fileMaxMb,
  } satisfies NearbyPrefs);
}

/** Settings → Nearby relay: the opt-in and its pause rules. Applied at once. */
export async function setRelayPrefs(change: Partial<RelayPrefs>): Promise<void> {
  await loadPrefs();
  const relay = { ...useNearby.getState().relay, ...change };
  useNearby.setState({ relay });
  const { db } = (await getCryptoContext()).database;
  await writeSetting(db, SETTING_KEYS.relay, relay satisfies RelayPrefs);
  await startNearby();
}

/** "Clear relay cache": other people's messages held here go; chats and own messages stay. */
export async function clearRelayCache(): Promise<void> {
  await current?.transport.mesh?.clear();
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
  await writeSetting(db, SETTING_KEYS.nearby, {
    enabled,
    fileMaxMb: useNearby.getState().fileMaxMb,
  } satisfies NearbyPrefs);
  await startNearby();
}

export type PermissionOutcome = 'granted' | 'denied' | 'blocked';

/** Asks for what the module reports missing; `blocked` means only the system settings can. */
export async function requestNearbyPermissions(): Promise<PermissionOutcome> {
  const state = await refreshNearby();
  const missing = (state?.missingPermissions ?? []) as Permission[];
  if (missing.length === 0) return 'granted';
  if (Platform.OS === 'ios') {
    // iOS asks for Bluetooth once, when the module first uses it (ADR 0033).
    const outcome = (await PingdostNearby?.requestPermission?.()) ?? 'denied';
    await refreshNearby();
    return outcome;
  }
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
  useNearby.setState({
    summary: { peers: [], unknown: 0, pending: 0 },
    loaded: false,
    mesh: null,
    relayDecision: { relaying: false, reason: 'off' },
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'error';
}
