// Shapes of the `PingdostNearby` module (Kotlin: modules/nearby/android, ADR 0023; Swift:
// modules/nearby/ios, ADR 0033). On iOS `address` is the CoreBluetooth peer identifier (a UUID,
// also not an identity), `power` is mapped onto the Android fields, and there is no foreground
// service.

export type ScanMode = 'lowLatency' | 'balanced' | 'lowPower';
export type AdvertiseInterval = 'low' | 'medium' | 'high';
export type TxPower = 'ultraLow' | 'low' | 'medium' | 'high';

export interface StartOptions {
  scanMode?: ScanMode;
  /** `low` ≈ 100 ms, `medium` ≈ 250 ms, `high` ≈ 1 s between adverts. */
  advertiseInterval?: AdvertiseInterval;
  txPower?: TxPower;
  /** How often the advertised random token changes (30–3600 s; default 600). */
  rotationSeconds?: number;
  /** Connect to discovered PingDost phones by itself; the side with the lower token connects. */
  autoConnect?: boolean;
  advertise?: boolean;
  scan?: boolean;
}

/** The reasons `start`, `connect` and `send` reject with (as `error.message`). */
export type NearbyError =
  | 'not_attached'
  | 'android_too_old'
  | 'no_ble'
  | 'no_bluetooth'
  | 'bluetooth_off'
  | 'permission'
  | 'too_many_links'
  | 'connecting'
  | 'timeout'
  | 'not_up'
  | 'link_down'
  | 'too_large'
  | 'queue_full'
  | 'not_allowed'
  | 'duplicate'
  | 'error'
  | (string & {});

export interface PowerState {
  batteryPercent: number;
  charging: boolean;
  powerSave: boolean;
  /** Doze. */
  deviceIdle: boolean;
  ignoringBatteryOptimizations: boolean;
  /** Screen on. */
  interactive: boolean;
  /** `ActivityManager.RunningAppProcessInfo.importance`: 100 foreground, 125 foreground service, 400 cached. */
  importance: number;
}

export interface LinkInfo {
  id: number;
  role: 'central' | 'peripheral';
  /** The peer's current random Bluetooth address (rotates; not an identity). */
  address: string;
  peerToken: string | null;
  up: boolean;
  /** ATT MTU; a frame carries MTU − 3 bytes. */
  mtu: number;
  /** 1 = LE 1M, 2 = LE 2M, 3 = Coded. */
  txPhy: number;
  rxPhy: number;
  /** From the connect call (or the peer's subscription) to both HELLOs. */
  setupMs: number | null;
  upAt: number;
  packetsSent: number;
  packetsReceived: number;
  bytesSent: number;
  bytesReceived: number;
  framesSent: number;
  framesReceived: number;
  unsent: number;
  outboundBytes: number;
  sendCredits: number;
}

export interface PeerInfo {
  address: string;
  /** Hex of the advertised 8-byte random token; null until a scan response arrives. */
  token: string | null;
  rssi: number;
  seenAgoMs: number;
  knownForMs: number;
  linked: boolean;
}

export interface NearbyState {
  supported: boolean;
  unsupportedReason: string | null;
  enabled: boolean;
  missingPermissions: string[];
  running: boolean;
  advertising: boolean;
  scanning: boolean;
  autoConnect: boolean;
  rotationSeconds: number;
  token: string;
  foregroundService: boolean;
  le2MPhy: boolean;
  extendedAdvertising: boolean;
  multipleAdvertisement: boolean;
  sdk: number;
  device: string;
  power: PowerState | null;
  inboundQueued: number;
  links: LinkInfo[];
  peers: PeerInfo[];
}

export interface LinkDownEvent {
  id: number;
  address: string;
  reason: NearbyError;
  /** Packets accepted by `send` that never went out (the caller resends them elsewhere). */
  unsent: number;
}

export interface LogEntry {
  message: string;
  at: number;
}

export type NearbyEvents = {
  peerDiscovered: (peer: PeerInfo & { first: boolean }) => void;
  peerLost: (event: { address: string }) => void;
  linkUp: (link: LinkInfo) => void;
  linkDown: (event: LinkDownEvent) => void;
  /** Packets wait in the native queue: call `receive` until it returns an empty batch. */
  packet: (event: { queued: number }) => void;
  stateChanged: (state: NearbyState) => void;
  log: (entry: LogEntry) => void;
};

export interface Subscription {
  remove(): void;
}

/** The native module's surface (structural, so tests can pass a fake). */
export interface NearbyNative {
  getState(): Promise<NearbyState>;
  start(options: StartOptions): Promise<void>;
  stop(): Promise<void>;
  rotateToken(): Promise<string>;
  connect(address: string): Promise<LinkInfo>;
  disconnect(linkId: number): Promise<void>;
  /** Resolves when the packet is in the link's native queue (backpressure), not on delivery. */
  send(linkId: number, data: Uint8Array): Promise<void>;
  /** Takes queued packets, at least one, up to `maxBytes` (see `parseInbound`). */
  receive(maxBytes: number): Uint8Array;
  startForegroundService(): Promise<void>;
  stopForegroundService(): Promise<void>;
  /** The service's notification: "PingDost nearby relay active" or "Nearby is on" (ADR 0025). */
  setRelayNotification?(relay: boolean): void;
  /** After a restart, a notification offers to open the app and turn nearby back on. */
  setRestartReminder?(enabled: boolean): void;
  /** iOS only: shows the Bluetooth prompt if it was never answered (ADR 0033). */
  requestPermission?(): Promise<'granted' | 'denied' | 'blocked'>;
  addListener<E extends keyof NearbyEvents>(event: E, listener: NearbyEvents[E]): Subscription;
}
