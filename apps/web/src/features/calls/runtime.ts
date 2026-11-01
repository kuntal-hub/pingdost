// Calls in this browser (ADR 0028). Every tab runs a call manager on the leader tab's E2EE
// signaling, so an incoming call rings in every tab. The tab that answers (or dials) holds the
// `pingdost-call` Web Lock for the whole call and tells the other tabs, which stop ringing;
// while the lock is held elsewhere, the other tabs leave new invites to that tab, which
// answers busy. Network changes restart ICE. Ended calls go to the local call history.
import { create } from 'zustand';

import type { ChatClient } from '@/chat/client';
import { useChat } from '@/chat/store';
import { api } from '@/session/session';
import {
  CallError,
  CallManager,
  isLive,
  type CallSnapshot,
  type IceServer,
} from '@pingdost/call-engine';

import { WebCallPlatform, type CallPath } from './platform';
import { callPrefs } from './prefs';
import { ringtone } from './ringtone';

const LOCK = 'pingdost-call';
const CHANNEL = 'pingdost-calls';
/** The service worker's "Incoming call" notice (sw.ts) and this tab's. */
export const CALL_NOTICE_TAG = 'pingdost-call';

interface CallsState {
  call: CallSnapshot | null;
  local: MediaStream | null;
  remote: MediaStream | null;
  /** How media flows once connected (direct or TURN), refreshed every few seconds. */
  path: CallPath | null;
  /** Why the last dial did not start (another tab is in a call). */
  notice: string | null;
}

export const useCalls = create<CallsState>()(() => ({
  call: null,
  local: null,
  remote: null,
  path: null,
  notice: null,
}));

interface Runtime {
  manager: CallManager;
  platform: WebCallPlatform;
  channel: BroadcastChannel;
  release: (() => void) | null;
}

let runtime: Runtime | null = null;

/** Takes the call lock if no other tab holds it; resolves to its release, or null. */
function takeLock(): Promise<(() => void) | null> {
  if (!('locks' in navigator)) return Promise.resolve(() => undefined);
  return new Promise((resolve) => {
    void navigator.locks
      .request(LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(() => resolve(null));
  });
}

async function lockHeld(): Promise<boolean> {
  if (!('locks' in navigator)) return false;
  const state = await navigator.locks.query();
  return (state.held ?? []).some((lock) => lock.name === LOCK);
}

async function notice(show: boolean): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (!registration) return;
  for (const shown of await registration.getNotifications({ tag: CALL_NOTICE_TAG })) {
    shown.close();
  }
  if (show && 'Notification' in window && Notification.permission === 'granted') {
    // Like the push's notice: nothing about who is calling (ADR 0015).
    await registration.showNotification('PingDost', {
      body: 'Incoming call',
      tag: CALL_NOTICE_TAG,
      requireInteraction: true,
      icon: '/icons/icon-192.png',
      data: { url: '/' },
    });
  }
}

/**
 * This tab's chat client at the time of use: it changes when this tab becomes the leader
 * (ADR 0020), and a call must survive that.
 */
function chat(): ChatClient {
  const client = useChat.getState().client;
  if (!client) throw new Error('PingDost is not running in this tab');
  return client;
}

/** Call signals from whichever client this tab has now. */
function onCallSignal(listener: Parameters<ChatClient['onCallSignal']>[0]): () => void {
  let current = useChat.getState().client;
  let unsubscribe = current?.onCallSignal(listener) ?? (() => undefined);
  const unwatch = useChat.subscribe((state) => {
    if (state.client === current) return;
    unsubscribe();
    current = state.client;
    unsubscribe = current?.onCallSignal(listener) ?? (() => undefined);
  });
  return () => {
    unwatch();
    unsubscribe();
  };
}

/** Starts calls for this tab; returns its stop. */
export function startCalls(self: { userId: string; deviceId: string }): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  const platform = new WebCallPlatform(
    async (): Promise<IceServer[]> => (await api.calls.turnCredentials()).iceServers,
    (media) => useCalls.setState(media),
  );
  const manager = new CallManager({
    self,
    signaling: {
      devices: (userId) => chat().callDevices(userId),
      send: (userId, deviceId, signal) => chat().sendCallSignal(userId, deviceId, signal),
      onSignal: onCallSignal,
    },
    platform,
    relayOnly: () => callPrefs.forceRelay(),
    // Another tab is in a call: it answers busy, this one stays quiet.
    incomingPolicy: async () => ((await lockHeld()) ? 'ignore' : 'ring'),
    onEnded: (call) => {
      runtime?.release?.();
      if (runtime) runtime.release = null;
      void notice(false);
      void Promise.resolve()
        .then(() =>
          chat().recordCall({
            callId: call.callId,
            peerUserId: call.peerUserId,
            direction: call.direction,
            video: call.video,
            startedAt: call.startedAt,
            durationMs:
              call.connectedAt !== null ? (call.endedAt ?? Date.now()) - call.connectedAt : 0,
            outcome: call.outcome ?? 'failed',
          }),
        )
        .catch(() => undefined);
    },
    ...(import.meta.env.DEV
      ? { log: (message, fields) => console.debug(`[calls] ${message}`, fields ?? '') }
      : {}),
  });
  runtime = { manager, platform, channel, release: null };

  let pathTimer: ReturnType<typeof setInterval> | undefined;
  const stopPath = () => {
    clearInterval(pathTimer);
    pathTimer = undefined;
  };
  manager.onChange((call) => {
    useCalls.setState({ call, ...(call && isLive(call.state) ? {} : { path: null }) });
    if (call?.state === 'incoming') {
      ringtone.start();
      if (document.visibilityState !== 'visible') void notice(true);
    } else {
      ringtone.stop();
    }
    if (call?.state === 'connected' && !pathTimer) {
      const read = () =>
        void platform.path().then(
          (path) => useCalls.setState({ path }),
          () => undefined,
        );
      read();
      pathTimer = setInterval(read, 3_000);
    }
    if (!call || !isLive(call.state)) stopPath();
  });

  channel.onmessage = (event: MessageEvent<{ type: 'claimed'; callId: string }>) => {
    if (event.data.type === 'claimed') manager.dismiss(event.data.callId);
  };

  const networkChanged = () => manager.networkChanged();
  const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
  window.addEventListener('online', networkChanged);
  connection?.addEventListener('change', networkChanged);
  // Closing the tab mid-call hangs up instead of leaving the other side to time out.
  const pagehide = () => void manager.hangup();
  window.addEventListener('pagehide', pagehide);

  return () => {
    window.removeEventListener('online', networkChanged);
    connection?.removeEventListener('change', networkChanged);
    window.removeEventListener('pagehide', pagehide);
    stopPath();
    ringtone.stop();
    void manager.dispose();
    runtime?.release?.();
    channel.close();
    runtime = null;
    useCalls.setState({ call: null, local: null, remote: null, path: null });
  };
}

/** Calls `peerUserId` from this tab. */
export async function dial(peerUserId: string, video: boolean): Promise<void> {
  const r = runtime;
  if (!r) return;
  useCalls.setState({ notice: null });
  if (r.manager.busy) return;
  const release = await takeLock();
  if (!release) {
    useCalls.setState({ notice: 'You are in a call in another PingDost tab.' });
    return;
  }
  r.release = release;
  try {
    const call = await r.manager.dial(peerUserId, { video });
    if (!isLive(call.state) && r.release === release) {
      release();
      r.release = null;
    }
  } catch (error) {
    release();
    r.release = null;
    if (!(error instanceof CallError)) throw error;
    useCalls.setState({ notice: 'You are already in a call.' });
  }
}

/** Answers the ringing call in this tab; another tab that answered first keeps it. */
export async function accept(): Promise<void> {
  const r = runtime;
  const call = r?.manager.call;
  if (!r || call?.state !== 'incoming') return;
  const release = await takeLock();
  if (!release) {
    r.manager.dismiss(call.callId);
    return;
  }
  r.release = release;
  r.channel.postMessage({ type: 'claimed', callId: call.callId });
  ringtone.stop();
  void notice(false);
  await r.manager.accept();
}

export async function decline(): Promise<void> {
  const r = runtime;
  const call = r?.manager.call;
  if (!r || call?.state !== 'incoming') return;
  r.channel.postMessage({ type: 'claimed', callId: call.callId });
  await r.manager.reject();
}

export function hangup(): Promise<void> {
  return runtime?.manager.hangup() ?? Promise.resolve();
}

export function setMuted(muted: boolean): void {
  runtime?.manager.setMuted(muted);
}

export function setCameraOff(off: boolean): void {
  runtime?.manager.setCameraOff(off);
}

export function switchInput(kind: 'microphone' | 'camera', deviceId: string): Promise<void> {
  return runtime?.platform.switchInput(kind, deviceId) ?? Promise.resolve();
}

/** Hides the "Call ended" line. */
export function clearEnded(): void {
  runtime?.manager.clearEnded();
}
