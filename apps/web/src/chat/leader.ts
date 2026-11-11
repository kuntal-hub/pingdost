// The leader tab's chat runtime (ADR 0020): the message engine on the Dexie store, the
// gateway socket, and this account's privacy settings and blocks. It answers the other tabs'
// calls and announces every change to them. Messages from this user's phone arrive here as
// copies from an own device and show as sent by "you". The history sync from the phone and
// attachment transfers run here too (ADR 0021).
import { Transfers } from '@/attachments/transfers';
import { publicConfig } from '@/config';
import { cryptoProvider } from '@/crypto/provider';
import {
  accessToken,
  api,
  loadAccount,
  loadPickleKey,
  refreshTokens,
  useSession,
} from '@/session/session';
import { syncWindow } from '@/sync/prefs';
import { MessageEngine, type ConversationEvent, type EngineEvent } from '@pingdost/message-engine';
import { TransportRouter, WsTransport } from '@pingdost/transport';
import { database, DexieEngineStore, vaultKey } from '@pingdost/web-store';

import type { BusMessage } from './bus';
import { ENGINE_METHODS, toWireError, type ChatClient } from './client';
import { useChat, type CircleLists } from './store';

export interface LeaderRuntime {
  client: ChatClient;
  /** Answers a follower's message; true when it was for the leader. */
  handle(message: BusMessage): void;
  stop(): Promise<void>;
}

/** Privacy settings and blocks, fetched now and whenever a tab changes them. */
async function loadPrefs(): Promise<void> {
  const [me, blocked] = await Promise.all([api.account.me(), api.security.listBlocks()]);
  useChat.setState({ privacy: me.privacy, blocked });
}

/** The engine setting that keeps the circle for offline starts (Phase 37). */
const CIRCLE_SETTING = 'app.circle';

/** The circle and requests from the server, cached in the sealed store; offline, the cache. */
async function loadCircle(store: DexieEngineStore): Promise<void> {
  try {
    const [members, requests] = await Promise.all([api.circles.list(), api.circles.requests()]);
    const circle = { members, incoming: requests.incoming, outgoing: requests.outgoing };
    useChat.setState({ circle });
    await store.apply({ settings: { [CIRCLE_SETTING]: JSON.stringify(circle) } });
  } catch {
    if (useChat.getState().circle) return;
    const cached = await store.getSetting(CIRCLE_SETTING).catch(() => undefined);
    if (typeof cached === 'string') useChat.setState({ circle: JSON.parse(cached) as CircleLists });
  }
}

export async function startLeader(
  post: (message: BusMessage) => void,
  onRevoked: () => void,
): Promise<LeaderRuntime> {
  const device = useSession.getState().device;
  if (!device || !publicConfig) throw new Error('this browser is not linked');
  const provider = await cryptoProvider();
  const account = await loadAccount(provider);
  const pickleKey = await loadPickleKey();
  if (!account || !pickleKey) throw new Error('the browser keys are missing');
  const db = database();
  const store = new DexieEngineStore(db, await vaultKey(db));

  await loadPrefs().catch(() => undefined);
  await loadCircle(store);
  const transport = new WsTransport({
    url: publicConfig.wsUrl,
    getAccessToken: accessToken,
    refreshToken: refreshTokens,
  });
  const router = new TransportRouter([transport]);
  const engine = new MessageEngine({
    self: {
      userId: device.userId,
      deviceId: device.deviceId,
      ...(device.accountIdentityKey ? { accountIdentityKey: device.accountIdentityKey } : {}),
    },
    crypto: provider,
    account,
    pickleKey,
    store,
    transport: router,
    api: { ...api.keys, keys: api.keys, groups: api.groups },
    receipts: (type) => {
      const privacy = useChat.getState().privacy;
      return type === 'read'
        ? (privacy?.readReceipts ?? false)
        : (privacy?.deliveryReceipts ?? true);
    },
    typingIndicators: () => useChat.getState().privacy?.typingIndicators ?? true,
    blocked: (userId) => useChat.getState().blocked.includes(userId),
    // One-to-one content only from the circle (Phase 37); unknown before the first load.
    circle: (userId) => {
      const circle = useChat.getState().circle;
      return circle ? circle.members.some((m) => m.userId === userId) : undefined;
    },
    // After pairing, the recent history comes from the phone by itself.
    historySync: { autoStart: true, window: syncWindow() },
    ...(import.meta.env.DEV
      ? {
          log: (level, message, fields) =>
            console.debug(`[engine] ${level}: ${message}`, fields ?? ''),
        }
      : {}),
  });

  const transfers = new Transfers(engine, provider, (status) => {
    for (const listener of transferListeners) listener(status);
    post({ type: 'transfer', status });
  });
  const transferListeners = new Set<Parameters<ChatClient['onTransfer']>[0]>();

  const cleanup: (() => void)[] = [];
  const sharePrefs = () => {
    const { privacy, blocked, circle } = useChat.getState();
    post({ type: 'prefs', privacy, blocked, circle });
  };
  cleanup.push(
    engine.subscribeAll((conversationId: string, event: ConversationEvent) =>
      post({ type: 'conversation', conversationId, event }),
    ),
    engine.onConversationListChanged(() => post({ type: 'list' })),
    engine.onEvent((event: EngineEvent) => post({ type: 'engine', event })),
    engine.onHistorySync((status) => post({ type: 'sync', status })),
    // Calls run in whichever tab the user uses (ADR 0028): every tab gets the signals.
    engine.onCallSignal((signal) => post({ type: 'call_signal', signal })),
    router.status$.subscribe(
      (status) => {
        useChat.setState({ status });
        post({ type: 'status', status });
        // Uploads cut off by a lost connection go on.
        if (status === 'online') void transfers.resumeUploads().catch(() => undefined);
      },
      { emitCurrent: true },
    ),
    transport.onEvent((event) => {
      switch (event.type) {
        case 'otk_low':
          void engine.replenishKeys().catch(() => undefined);
          break;
        case 'presence':
          useChat.setState((state) => ({
            presence: { ...state.presence, [event.userId]: event.online },
          }));
          post({ type: 'presence', userId: event.userId, online: event.online });
          break;
        case 'group_changed':
          void engine.syncGroup(event.groupId).catch(() => undefined);
          break;
        case 'circle_changed':
          void loadCircle(store).then(sharePrefs, () => undefined);
          break;
        case 'revoked':
          onRevoked();
          break;
        case 'auth_failed':
          if (event.code === 'DEVICE_REVOKED') onRevoked();
          break;
        default:
          break;
      }
    }),
  );
  // Online while a PingDost tab is visible (the peer sees it only if this user shares it).
  const visibility = () => transport.setPresence(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', visibility);
  cleanup.push(() => document.removeEventListener('visibilitychange', visibility));

  const local = Object.fromEntries(
    ENGINE_METHODS.map((name) => [
      name,
      (...args: unknown[]) =>
        (engine[name] as (...a: unknown[]) => Promise<unknown>).apply(engine, args),
    ]),
  );
  const client = {
    ...local,
    watchPresence: (userIds: string[]) => {
      transport.watchPresence(userIds);
      return Promise.resolve();
    },
    downloadAttachment: (messageId, role) => transfers.download(messageId, role),
    sendFile: (conversationId, file, options) => transfers.sendFile(conversationId, file, options),
    forwardFile: (messageId, conversationIds, forwarded) =>
      transfers.forwardFile(messageId, conversationIds, forwarded),
    retryUpload: (messageId) => transfers.retryUpload(messageId),
    transfers: () => Promise.resolve(transfers.snapshot()),
    applyCacheLimit: () => transfers.applyCacheLimit(),
    clearCache: () => transfers.clearCache(),
    subscribe: (conversationId, listener) => engine.subscribe(conversationId, listener),
    onListChanged: (listener) => engine.onConversationListChanged(listener),
    onEngineEvent: (listener) => engine.onEvent(listener),
    onHistorySync: (listener) => engine.onHistorySync(listener),
    onCallSignal: (listener) => engine.onCallSignal(listener),
    onTransfer: (listener) => {
      transferListeners.add(listener);
      return () => {
        transferListeners.delete(listener);
      };
    },
  } as ChatClient;

  await engine.start();
  transport.start();
  visibility();
  // Heals an interrupted first key upload and tops up one-time keys (ADR 0011).
  void engine.replenishKeys({ ensureFallback: true }).catch(() => undefined);

  const handle = (message: BusMessage) => {
    switch (message.type) {
      case 'call': {
        const { id, from, method, args } = message;
        // Called on the client, so the engine method keeps its `this`.
        const methods = client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        void methods[method]!(...args).then(
          (value) => post({ type: 'result', id, to: from, ok: true, value }),
          (error: unknown) =>
            post({ type: 'result', id, to: from, ok: false, error: toWireError(error) }),
        );
        break;
      }
      case 'hello':
        sharePrefs();
        post({ type: 'status', status: router.status$.value });
        void engine.historySyncStatus().then((status) => post({ type: 'sync', status }));
        break;
      case 'prefs_changed':
        void Promise.all([loadPrefs(), loadCircle(store)]).then(sharePrefs, () => undefined);
        break;
      default:
        break;
    }
  };

  return {
    client,
    handle,
    async stop() {
      for (const remove of cleanup.splice(0)) remove();
      transport.stop();
      await engine.stop();
      router.dispose();
    },
  };
}
