// Calls on this phone (Phase 26, ADR 0029): the shared call manager on the engine's E2EE
// signaling, react-native-webrtc for media, and the `PingdostCalls` module for what Android
// needs around a call:
// - an incoming call rings in the app when it is on screen, else as a call notification with
//   a full-screen intent (over the lock screen); Answer opens `pingdost://call`;
// - a live call runs a `phoneCall` foreground service, communication audio (earpiece for voice,
//   speaker for video, a headset or Bluetooth when there), the proximity screen-off at the ear,
//   and keeps the screen on; the socket stays open in the background meanwhile;
// - Wi-Fi ↔ mobile data or a reconnect restarts ICE ("Reconnecting");
// - a GSM call going on answers new invites busy;
// - ended calls go to the local history; a missed one makes a notification.
// On iOS (Phase 29, ADR 0032) CallKit does the ringing, the incoming-call screen and the lock
// screen, and owns the audio session; `CallKitBridge` keeps it in step with the manager. The
// module's Android-only functions are no-ops there.
import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { RTCAudioSession, type MediaStream } from 'react-native-webrtc';
import { create } from 'zustand';

import { api } from '@/api';
import { contactName, loadContact } from '@/engine/contacts';
import { ensureChannels, MISSED_CALLS_CHANNEL } from '@/push/notifications';
import { useNotificationPrefs } from '@/push/prefs';
import { CallError, CallManager, isLive, type CallSnapshot } from '@pingdost/call-engine';
import type { MessageEngine } from '@pingdost/message-engine';

import { CallKitBridge } from './callkit';
import { missedCallContent, wantsProximity } from './logic';
import { grantCallPermissions, NativeCallPlatform } from './platform';
import { useCallPrefs } from './prefs';
import { consumeCallKitEvents } from './voip';
import {
  callKitNative,
  PingdostCalls,
  type AudioRoute,
  type AudioRoutes,
} from '../../modules/pingdost-calls/src';

interface CallsState {
  call: CallSnapshot | null;
  local: MediaStream | null;
  remote: MediaStream | null;
  routes: AudioRoutes | null;
  /** Why the last dial did not start. */
  notice: string | null;
}

export const useCalls = create<CallsState>()(() => ({
  call: null,
  local: null,
  remote: null,
  routes: null,
  notice: null,
}));

interface Running {
  manager: CallManager;
  platform: NativeCallPlatform;
  /** iOS only. */
  callkit: CallKitBridge | null;
}

let running: Running | null = null;

/** A call is ringing or live: the socket must stay open even in the background. */
export function callInProgress(): boolean {
  const call = useCalls.getState().call;
  return call !== null && isLive(call.state);
}

/** The caller's name for notifications: hidden when previews hide senders. */
async function nameFor(userId: string): Promise<string | undefined> {
  const prefs = await useNotificationPrefs
    .getState()
    .load()
    .catch(() => undefined);
  if (prefs?.hideSender) return undefined;
  return contactName(await loadContact(userId).catch(() => undefined));
}

export function startCalls(chat: {
  engine: MessageEngine;
  userId: string;
  deviceId: string;
}): () => void {
  const native = Platform.OS === 'android' || Platform.OS === 'ios' ? PingdostCalls : null;
  const callkitNative = Platform.OS === 'ios' ? callKitNative() : null;
  const platform = new NativeCallPlatform(
    async () => (await api.calls.turnCredentials()).iceServers,
    (media) => useCalls.setState(media),
  );
  void useCallPrefs
    .getState()
    .load()
    .catch(() => undefined);
  const manager = new CallManager({
    self: { userId: chat.userId, deviceId: chat.deviceId },
    signaling: {
      devices: (userId) => chat.engine.callDevices(userId),
      send: (userId, deviceId, signal) => chat.engine.sendCallSignal(userId, deviceId, signal),
      onSignal: (listener) => chat.engine.onCallSignal(listener),
    },
    platform,
    relayOnly: () => useCallPrefs.getState().prefs.forceRelay,
    // A phone call is going on: busy (REQ §12.2).
    incomingPolicy: () => (native?.inSystemCall() ? 'busy' : 'ring'),
    onEnded: (call) => {
      void chat.engine
        .recordCall({
          callId: call.callId,
          peerUserId: call.peerUserId,
          direction: call.direction,
          video: call.video,
          startedAt: call.startedAt,
          durationMs:
            call.connectedAt !== null ? (call.endedAt ?? Date.now()) - call.connectedAt : 0,
          outcome: call.outcome ?? 'failed',
        })
        .catch(() => undefined);
      if (call.direction === 'in' && call.outcome === 'missed') void notifyMissed(call);
    },
    ...(__DEV__
      ? { log: (message, fields) => console.debug(`[calls] ${message}`, fields ?? '') }
      : {}),
  });
  const callkit = callkitNative
    ? new CallKitBridge(
        callkitNative,
        {
          accept: (callId) => void accept(callId).catch(() => undefined),
          reject: () => void manager.reject(),
          hangup: () => void manager.hangup(),
          setMuted: (muted) => manager.setMuted(muted),
          // WebRTC must hear about CallKit's session, or calls answered from the lock
          // screen have no sound.
          audio: (active) => {
            if (active) RTCAudioSession.audioSessionDidActivate();
            else RTCAudioSession.audioSessionDidDeactivate();
          },
        },
        { randomUuid: () => Crypto.randomUUID() },
      )
    : null;
  running = { manager, platform, callkit };

  let previous: CallSnapshot | null = null;
  let mediaFor: string | null = null;
  const names = new Map<string, string>();

  const ring = (call: CallSnapshot) => {
    // CallKit rings on iOS.
    if (!native || callkit) return;
    if (AppState.currentState === 'active') {
      native.cancelIncoming();
      native.startRinging();
    } else {
      native.stopRinging();
      native.showIncoming(call.callId, names.get(call.callId) ?? 'PingDost', call.video);
    }
  };
  const stopRinging = () => {
    native?.stopRinging();
    native?.cancelIncoming();
  };
  const updateProximity = () => {
    native?.setProximityScreenOff(
      wantsProximity(useCalls.getState().call, useCalls.getState().routes?.current ?? null),
    );
  };
  const startMedia = (call: CallSnapshot) => {
    if (!native || mediaFor === call.callId) return;
    mediaFor = call.callId;
    native.startAudio(call.video);
    native.startOngoing(call.callId, names.get(call.callId) ?? 'PingDost call', call.video);
    native.setKeepScreenOn(true);
    useCalls.setState({ routes: native.audioRoutes() });
    updateProximity();
  };
  const stopMedia = () => {
    mediaFor = null;
    if (!native) return;
    native.setProximityScreenOff(false);
    native.stopAudio();
    native.stopOngoing();
    native.setKeepScreenOn(false);
    native.setShowWhenLocked(false);
    useCalls.setState({ routes: null });
  };

  // Synchronous, so a quick ring-then-cancel can never leave the phone ringing; the name for
  // the notifications follows a moment later.
  const onChange = (call: CallSnapshot | null) => {
    const before = previous;
    previous = call;
    useCalls.setState({ call });
    if (call && !names.has(call.callId)) {
      const { callId, peerUserId } = call;
      names.set(callId, 'PingDost');
      void nameFor(peerUserId).then((name) => {
        if (name) names.set(callId, name);
        const now = manager.call;
        // Off screen, the notification (or CallKit) shows the name once it is known.
        if (name && now?.callId === callId && now.state === 'incoming') {
          ring(now);
          callkit?.onCall(now, name);
        }
      });
    }
    callkit?.onCall(call, call ? (names.get(call.callId) ?? 'PingDost') : 'PingDost');
    if (call?.state === 'incoming' && before?.callId !== call.callId) ring(call);
    if (before?.state === 'incoming' && call?.state !== 'incoming') stopRinging();
    if (call && ['outgoing', 'connecting'].includes(call.state)) startMedia(call);
    if (call?.state === 'ended' && before && before.state !== 'ended') {
      stopRinging();
      stopMedia();
    }
    updateProximity();
  };
  const unsubscribe = manager.onChange(onChange);

  const handleAction = ({ action, callId }: { action: string; callId: string }) => {
    if (manager.call?.callId !== callId) return;
    if (action === 'decline') void manager.reject();
    if (action === 'hangup') void manager.hangup();
  };
  const listeners = native
    ? [
        native.addListener('action', handleAction),
        native.addListener('audioRoutes', (routes) => {
          useCalls.setState({ routes });
          updateProximity();
        }),
      ]
    : [];
  for (const action of native?.takePendingActions() ?? []) handleAction(action);
  const stopCallKit = callkit ? consumeCallKitEvents((event) => callkit.onEvent(event)) : null;

  // On screen the app rings; off screen the notification does.
  const appState = AppState.addEventListener('change', () => {
    const call = manager.call;
    if (call?.state === 'incoming') ring(call);
  });
  // Wi-Fi ↔ mobile data, or the network came back: restart ICE now.
  let lastType: Network.NetworkStateType | undefined;
  const network = Network.addNetworkStateListener((state) => {
    const changed = lastType !== undefined && state.type !== lastType;
    lastType = state.type;
    if (state.isConnected && changed) manager.networkChanged();
  });

  return () => {
    unsubscribe();
    stopCallKit?.();
    callkit?.dispose();
    for (const listener of listeners) listener.remove();
    appState.remove();
    network.remove();
    stopRinging();
    stopMedia();
    void manager.dispose();
    running = null;
    useCalls.setState({ call: null, local: null, remote: null, routes: null });
  };
}

async function notifyMissed(call: CallSnapshot): Promise<void> {
  try {
    await ensureChannels();
    const { title, body } = missedCallContent(call, await nameFor(call.peerUserId));
    await Notifications.scheduleNotificationAsync({
      identifier: `missed-${call.callId}`,
      content: { title, body, data: { missedCallFrom: call.peerUserId } },
      trigger: Platform.OS === 'android' ? { channelId: MISSED_CALLS_CHANNEL } : null,
    });
  } catch (error) {
    if (__DEV__) console.warn('[calls] missed-call notification failed', error);
  }
}

/** Calls `peerUserId`; false when it did not start (no permission, or already in a call). */
export async function dial(peerUserId: string, video: boolean): Promise<boolean> {
  const r = running;
  if (!r) return false;
  useCalls.setState({ notice: null });
  if (!(await grantCallPermissions(video))) {
    const settings = Platform.OS === 'ios' ? 'Settings' : 'Android settings';
    useCalls.setState({
      notice: video
        ? `Video calls need the microphone and camera. Allow them in ${settings}.`
        : `Calls need the microphone. Allow it in ${settings}.`,
    });
    return false;
  }
  try {
    await r.manager.dial(peerUserId, { video });
    return true;
  } catch (error) {
    if (!(error instanceof CallError)) throw error;
    useCalls.setState({ notice: 'You are already in a call.' });
    return false;
  }
}

export async function accept(callId?: string): Promise<void> {
  const r = running;
  const call = r?.manager.call;
  if (!r || call?.state !== 'incoming' || (callId && call.callId !== callId)) return;
  await r.manager.accept();
}

/** The user ended the call on our screen: CallKit hears it as a local end. */
function markLocalEnd(r: Running | null): void {
  const call = r?.manager.call;
  if (call) r?.callkit?.endedLocally(call.callId);
}

export function decline(): Promise<void> {
  markLocalEnd(running);
  return running?.manager.reject() ?? Promise.resolve();
}

export function hangup(): Promise<void> {
  markLocalEnd(running);
  return running?.manager.hangup() ?? Promise.resolve();
}

export function setMuted(muted: boolean): void {
  running?.manager.setMuted(muted);
}

export function setCameraOff(off: boolean): void {
  running?.manager.setCameraOff(off);
}

export function switchCamera(): Promise<void> {
  return running?.platform.switchCamera() ?? Promise.resolve();
}

export function setAudioRoute(route: AudioRoute): void {
  if (!PingdostCalls?.setAudioRoute(route)) return;
  useCalls.setState({ routes: PingdostCalls.audioRoutes() });
  PingdostCalls.setProximityScreenOff(wantsProximity(useCalls.getState().call, route));
}

/** Forgets the ended call shown on the call screen. */
export function clearEnded(): void {
  running?.manager.clearEnded();
}
