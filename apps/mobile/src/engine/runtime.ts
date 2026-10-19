// The chat engine of the signed-in device (ADR 0012): one per process, started in the
// `ready` stage and stopped on sign-out. It owns the gateway socket:
// - foreground: connected, presence "online" (if the user shares it);
// - background: presence off at once, the socket closed after a grace period (push wakes the
//   app from Phase 12);
// - network back: reconnect now instead of waiting out the backoff;
// - 4001: token refresh through the auth store; revoked: chat data wiped and signed out.
// While the engine runs, every change to the Olm account goes through it. Receipts, typing
// and blocks follow the account's privacy settings and block list (Phase 11).
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { api, authStore } from '@/api';
import { publicConfig } from '@/config';
import { getCryptoContext } from '@/crypto/bootstrap';
import { getOrCreateSecret, SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { cachedPrivacy, useAccount } from '@/settings/account';
import type { CryptoProvider } from '@pingdost/crypto/core';
import { MessageEngine } from '@pingdost/message-engine';
import { TransportRouter, WsTransport, type TransportStatus } from '@pingdost/transport';

import { isBlocked, useBlocks } from './blocks';
import { SqliteEngineStore, wipeChatData } from './sqlite-store';

/** How long the socket stays open after the app leaves the foreground. */
const BACKGROUND_GRACE_MS = 30_000;

export interface ChatRuntime {
  engine: MessageEngine;
  transport: WsTransport;
  userId: string;
  deviceId: string;
  /** This account's identity key (public), for safety numbers. */
  accountIdentityKey: string | undefined;
}

interface ChatState {
  runtime: ChatRuntime | null;
  status: TransportStatus;
  /** Watched users' presence (the open chat's peer), when they share it. */
  presence: Record<string, boolean>;
  /** A newer socket of this device took over (e.g. a second app process). */
  replaced: boolean;
}

export const useChatStore = create<ChatState>()(() => ({
  runtime: null,
  status: 'offline',
  presence: {},
  replaced: false,
}));

let running: Promise<ChatRuntime> | undefined;
let teardown: (() => Promise<void>) | undefined;

/** Starts the engine once; later calls return the same runtime. */
export function startChat(): Promise<ChatRuntime> {
  running ??= boot().catch((error: unknown) => {
    running = undefined;
    throw error;
  });
  return running;
}

/** Stops the engine and closes the socket. Local data stays. */
export async function stopChat(): Promise<void> {
  const current = running;
  running = undefined;
  if (!current) return;
  await current.catch(() => undefined);
  const stop = teardown;
  teardown = undefined;
  await stop?.();
  useChatStore.setState({ runtime: null, status: 'offline', presence: {}, replaced: false });
}

/** Shows only the given users' presence (pass [] when no chat is open). */
export function watchPresence(userIds: string[]): void {
  useChatStore.getState().runtime?.transport.watchPresence(userIds);
}

async function ownIdentityKey(provider: CryptoProvider): Promise<string | undefined> {
  const secret = await SecureStore.getItemAsync(
    SECRET_ITEMS.accountIdentityKey,
    SECURE_STORE_OPTIONS,
  );
  if (!secret) return undefined;
  const key = provider.restoreSigningKey(secret);
  try {
    return key.publicKey();
  } finally {
    key.dispose();
  }
}

async function boot(): Promise<ChatRuntime> {
  const session = authStore.getState().session;
  if (!session?.deviceId || !publicConfig) throw new Error('chat needs a registered device');
  const userId = session.user.userId;
  const deviceId = session.deviceId;
  const context = await getCryptoContext();
  const { db } = context.database;
  const pickleKey = await getOrCreateSecret(SECRET_ITEMS.pickleKey);
  const accountIdentityKey = await ownIdentityKey(context.provider);

  const transport = new WsTransport({
    url: publicConfig.wsUrl,
    getAccessToken: () => authStore.getState().accessToken(),
    refreshToken: () => authStore.getState().refresh(),
  });
  const router = new TransportRouter([transport]);
  const engine = new MessageEngine({
    self: { userId, deviceId, ...(accountIdentityKey ? { accountIdentityKey } : {}) },
    crypto: context.provider,
    account: context.store.account,
    pickleKey,
    store: new SqliteEngineStore(db),
    transport: router,
    api: { ...api.keys, keys: api.keys },
    // The privacy toggles (Settings → Privacy); read receipts are reciprocal (ADR 0014).
    receipts: (type) => {
      const privacy = useAccount.getState().privacy;
      return type === 'read'
        ? (privacy?.readReceipts ?? false)
        : (privacy?.deliveryReceipts ?? true);
    },
    typingIndicators: () => useAccount.getState().privacy?.typingIndicators ?? true,
    blocked: isBlocked,
    ...(__DEV__
      ? {
          log: (level: string, message: string, fields?: object) =>
            console.log(`[engine] ${level}: ${message}`, fields ?? ''),
        }
      : {}),
  });

  const cleanup: (() => void)[] = [];
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined;

  const foreground = () => {
    clearTimeout(backgroundTimer);
    transport.start();
    transport.reconnectNow();
    transport.setPresence(true);
  };
  const background = () => {
    transport.setPresence(false);
    clearTimeout(backgroundTimer);
    backgroundTimer = setTimeout(() => transport.stop(), BACKGROUND_GRACE_MS);
  };

  cleanup.push(
    router.status$.subscribe((status) => useChatStore.setState({ status }), { emitCurrent: true }),
    transport.onEvent((event) => {
      switch (event.type) {
        case 'otk_low':
          void engine.replenishKeys().catch(() => undefined);
          break;
        case 'presence':
          useChatStore.setState((state) => ({
            presence: { ...state.presence, [event.userId]: event.online },
          }));
          break;
        case 'replaced':
          useChatStore.setState({ replaced: true });
          break;
        case 'revoked':
          void revoked();
          break;
        default:
          break;
      }
    }),
  );
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') foreground();
    else background();
  });
  cleanup.push(() => appState.remove());
  const network = Network.addNetworkStateListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) transport.reconnectNow();
  });
  cleanup.push(() => network.remove());

  /** This device was revoked: its identity is burned, so its chats and sessions go too. */
  async function revoked() {
    await stopChat();
    await wipeChatData(db).catch(() => undefined);
    await authStore.getState().logout();
  }

  teardown = async () => {
    clearTimeout(backgroundTimer);
    for (const remove of cleanup.splice(0)) remove();
    transport.stop();
    await engine.stop();
    router.dispose();
  };

  // The toggles and block list the engine consults: the cached copies before any message is
  // handled, then the server's in the background.
  const privacy = await cachedPrivacy().catch(() => null);
  if (privacy && !useAccount.getState().privacy) useAccount.setState({ privacy });
  await useBlocks
    .getState()
    .loadCached()
    .catch(() => undefined);
  void useAccount
    .getState()
    .load()
    .catch(() => undefined);
  void useBlocks
    .getState()
    .load()
    .catch(() => undefined);
  await engine.start();
  if (AppState.currentState === 'active') foreground();
  // Heals an interrupted first key upload and tops up one-time keys (ADR 0011).
  void engine.replenishKeys({ ensureFallback: true }).catch(() => undefined);

  const runtime: ChatRuntime = { engine, transport, userId, deviceId, accountIdentityKey };
  useChatStore.setState({ runtime });
  return runtime;
}
