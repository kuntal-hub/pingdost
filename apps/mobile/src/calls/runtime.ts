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
// In a call (ADR 0037):
// - voice ↔ video (the sound moves between earpiece and speaker; the foreground service adds
//   its camera type), screen sharing (PingDost's own window is secure meanwhile, so other chats
//   never show in the share), front ↔ back camera;
// - leaving the app during a video call shrinks it into picture-in-picture; without it (the
//   lock screen, PiP turned off), the camera pauses until the app is back. The call itself
//   goes on in the background either way;
// - camera filters and effects (ADR 0038): the PingdostCalls module draws the chosen one on
//   every camera frame; each call starts without one.
// On iOS (Phase 29, ADR 0032) CallKit does the ringing, the incoming-call screen and the lock
// screen, and owns the audio session; `CallKitBridge` keeps it in step with the manager. The
// module's Android-only functions are no-ops there.
import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as Notifications from 'expo-notifications';
import * as ScreenCapture from 'expo-screen-capture';
import { AppState, Dimensions, Platform } from 'react-native';
import { RTCAudioSession, type MediaStream } from 'react-native-webrtc';
import { create } from 'zustand';

import { api } from '@/api';
import { contactName, loadContact } from '@/engine/contacts';
import { ensureChannels, MISSED_CALLS_CHANNEL } from '@/push/notifications';
import { useNotificationPrefs } from '@/push/prefs';
import {
  availableEffects,
  CallError,
  CallManager,
  CallMediaError,
  effectFragmentShader,
  isLive,
  videoEffect,
  type CallSnapshot,
  type ScreenSurface,
  type VideoEffect,
} from '@pingdost/call-engine';
import type { MessageEngine } from '@pingdost/message-engine';

import { CallKitBridge } from './callkit';
import {
  missedCallContent,
  routeAfterSwitch,
  screenShareChoices,
  shouldPauseCamera,
  wantsPip,
  wantsProximity,
} from './logic';
import { deviceTag, grantCallPermissions, NativeCallPlatform } from './platform';
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
  /** The camera's self view. */
  local: MediaStream | null;
  /** The other side's picture (camera or screen). */
  remote: MediaStream | null;
  /** The front camera is in use: the self view is mirrored. */
  front: boolean;
  routes: AudioRoutes | null;
  /** Why the last action did not work (a dial, a switch to video, screen sharing). */
  notice: string | null;
  /** The app is in picture-in-picture: only the call's picture shows. */
  pip: boolean;
  /** The camera was paused because nobody could see the app; it comes back on return. */
  autoPaused: boolean;
  /** The camera effect of this call ('none', or an ID from `VIDEO_EFFECTS`; ADR 0038). */
  effect: string;
}

export const useCalls = create<CallsState>()(() => ({
  call: null,
  local: null,
  remote: null,
  front: true,
  routes: null,
  notice: null,
  pip: false,
  autoPaused: false,
  effect: 'none',
}));

/** expo-screen-capture key: PingDost's window stays out of a shared screen. */
const SHARE_GUARD = 'call-screen-share';

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
  const pipSupported = native?.pipSupported?.() ?? false;
  const platform = new NativeCallPlatform(
    async () => (await api.calls.turnCredentials()).iceServers,
    (media) => useCalls.setState(media),
    native?.setVideoEffect ? (native.videoEffectsProcessor?.() ?? null) : null,
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
    // `console.log`: Metro does not show `console.debug`. Two phones share one Metro, so the
    // model tells them apart.
    ...(__DEV__
      ? {
          log: (message, fields) => console.log(`[calls ${deviceTag()}] ${message}`, fields ?? ''),
        }
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
  // PingDost's window is secure while this side shares its screen (ADR 0037).
  let shareGuard = false;
  /** The picture-in-picture state last given to Android ('off', or call and mute). */
  let pipKey = 'off';
  const setShareGuard = (on: boolean) => {
    if (shareGuard === on) return;
    shareGuard = on;
    const change = on
      ? ScreenCapture.preventScreenCaptureAsync(SHARE_GUARD)
      : ScreenCapture.allowScreenCaptureAsync(SHARE_GUARD);
    void change.catch(() => undefined);
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
    setShareGuard(false);
    if (pipKey !== 'off') {
      pipKey = 'off';
      native?.setPip?.(false, false, '');
    }
    if (useCalls.getState().pip) native?.exitPip?.();
    // The next call starts without an effect.
    native?.setVideoEffect?.('none', '', false);
    useCalls.setState({ pip: false, autoPaused: false, effect: 'none' });
    if (!native) return;
    native.setProximityScreenOff(false);
    native.stopAudio();
    native.stopOngoing();
    native.setKeepScreenOn(false);
    native.setShowWhenLocked(false);
    useCalls.setState({ routes: null });
  };

  // ADR 0037: what follows the call's in-call changes.
  /** The camera is in use (a video call, or this side asking for one). */
  const usesCamera = (call: CallSnapshot | null) =>
    call !== null && (call.video || call.videoRequest === 'out');
  const onMediaChange = (call: CallSnapshot, before: CallSnapshot | null) => {
    // The call's first snapshot: `startMedia` set everything up for its kind.
    if (!native || !before || mediaFor !== call.callId || !isLive(call.state)) return;
    const name = names.get(call.callId) ?? 'PingDost call';
    // Started again from the foreground: the service adds its camera type for the camera.
    if (usesCamera(call) && !usesCamera(before) && AppState.currentState === 'active') {
      try {
        native.startOngoing(call.callId, name, true);
      } catch {
        // The call goes on; only the camera may stop in the background.
      }
    }
    if (before && before.video !== call.video) {
      // Android's routes now, not the stored copy (it may lag behind the device).
      const routes = native.audioRoutes();
      const route = routeAfterSwitch(call.video, routes);
      const moved = route ? native.setAudioRoute(route) : false;
      if (__DEV__) {
        console.log(`[calls ${deviceTag()}] route after switch`, {
          video: call.video,
          current: routes.current,
          route,
          moved,
        });
      }
      useCalls.setState({ routes: native.audioRoutes() });
      if (!call.video && AppState.currentState === 'active') {
        try {
          native.startOngoing(call.callId, name, false);
        } catch {
          // Only the notification's wording.
        }
      }
    }
  };
  const updatePip = (call: CallSnapshot | null) => {
    if (!pipSupported || !native?.setPip) return;
    const wanted = call !== null && mediaFor === call.callId && wantsPip(call);
    const key = wanted ? `${call.callId}:${call.muted}` : 'off';
    if (key === pipKey) return;
    pipKey = key;
    native.setPip(wanted, call?.muted ?? false, call?.callId ?? '');
  };
  /**
   * Pauses the camera while nobody sees the app; turns it back on when they do. The window's
   * visibility comes from the module (picture-in-picture counts as seen); a build without it
   * falls back to the app state.
   */
  const reviewCamera = () => {
    const call = manager.call;
    const { autoPaused, pip } = useCalls.getState();
    const seen = native?.isAppVisible
      ? native.isAppVisible()
      : AppState.currentState === 'active' || pip;
    if (autoPaused) {
      if (!seen && call && isLive(call.state)) return;
      useCalls.setState({ autoPaused: false });
      if (call?.video && isLive(call.state)) manager.setCameraOff(false);
      return;
    }
    if (shouldPauseCamera(call, seen, false)) {
      useCalls.setState({ autoPaused: true });
      manager.setCameraOff(true);
    }
  };
  const refreshPip = () => {
    const pip = native?.isInPictureInPicture?.() ?? false;
    if (useCalls.getState().pip !== pip) useCalls.setState({ pip });
    reviewCamera();
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
    if (call && isLive(call.state)) {
      onMediaChange(call, before?.callId === call.callId ? before : null);
      setShareGuard(call.screenSharing);
    }
    updatePip(call);
    updateProximity();
  };
  const unsubscribe = manager.onChange(onChange);

  const handleAction = ({ action, callId }: { action: string; callId: string }) => {
    if (manager.call?.callId !== callId) return;
    if (action === 'decline') void manager.reject();
    if (action === 'hangup') void manager.hangup();
    // The picture-in-picture window's button.
    if (action === 'mute' || action === 'unmute') manager.setMuted(action === 'mute');
  };
  const listeners = native
    ? [
        native.addListener('action', handleAction),
        native.addListener('audioRoutes', (routes) => {
          useCalls.setState({ routes });
          updateProximity();
        }),
        // Hidden or shown again (another app, the lock screen, PiP closed): the camera follows.
        native.addListener('visibility', () => refreshPip()),
      ]
    : [];
  for (const action of native?.takePendingActions() ?? []) handleAction(action);
  const stopCallKit = callkit ? consumeCallKitEvents((event) => callkit.onEvent(event)) : null;

  // On screen the app rings; off screen the notification does. Leaving the app may shrink a
  // video call into picture-in-picture: Android takes a moment, so it is checked again. (JS
  // timers stop in the background; the module's `visibility` event covers the rest.)
  let pipTimers: ReturnType<typeof setTimeout>[] = [];
  const stopPipWatch = () => {
    for (const timer of pipTimers) clearTimeout(timer);
    pipTimers = [];
  };
  const appState = AppState.addEventListener('change', (next) => {
    const call = manager.call;
    if (call?.state === 'incoming') ring(call);
    stopPipWatch();
    if (next === 'active') {
      refreshPip();
      return;
    }
    if (!call || !isLive(call.state)) return;
    pipTimers = [300, 1_000].map((ms) => setTimeout(refreshPip, ms));
  });
  // Entering and leaving picture-in-picture resizes the window.
  const dimensions = Dimensions.addEventListener('change', refreshPip);
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
    dimensions.remove();
    stopPipWatch();
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

const CAMERA_SETTINGS = Platform.OS === 'ios' ? 'Settings' : 'Android settings';

/** A notice for an in-call action that failed; other errors go on up. */
function noticeFor(error: unknown): void {
  if (error instanceof CallMediaError) {
    useCalls.setState({
      notice:
        error.reason === 'denied'
          ? `Video needs the camera. Allow it in ${CAMERA_SETTINGS}.`
          : 'The camera is not available.',
    });
    return;
  }
  if (error instanceof CallError && error.code === 'no_video') {
    useCalls.setState({
      notice: 'This call cannot switch to video: the other app needs an update.',
    });
    return;
  }
  throw error;
}

/** Voice → video: asks the other side (or agrees, if they asked first). */
export async function requestVideo(): Promise<void> {
  const r = running;
  if (!r) return;
  useCalls.setState({ notice: null });
  if (!(await grantCallPermissions(true))) {
    noticeFor(new CallMediaError('denied'));
    return;
  }
  await r.manager.requestVideo().catch(noticeFor);
}

export async function acceptVideo(): Promise<void> {
  const r = running;
  if (!r) return;
  if (!(await grantCallPermissions(true))) {
    r.manager.declineVideo();
    noticeFor(new CallMediaError('denied'));
    return;
  }
  await r.manager.acceptVideo().catch(noticeFor);
}

export function declineVideo(): void {
  running?.manager.declineVideo();
}

export function cancelVideoRequest(): void {
  running?.manager.cancelVideoRequest();
}

/** Video → voice for both sides. */
export function switchToVoice(): void {
  running?.manager.switchToVoice();
}

/** What this phone can share: one app from Android 14, else the whole screen. */
export function shareChoices(): ScreenSurface[] {
  if (Platform.OS !== 'android') return [];
  return screenShareChoices(typeof Platform.Version === 'number' ? Platform.Version : 0);
}

/** Shares one app or the whole screen, after Android's own consent dialog. */
export async function startScreenShare(surface: ScreenSurface): Promise<void> {
  const r = running;
  if (!r) return;
  useCalls.setState({ notice: null });
  const result = await r.manager.startScreenShare(surface).catch((error: unknown) => {
    noticeFor(error);
    return 'cancelled' as const;
  });
  if (result === 'unavailable') {
    useCalls.setState({ notice: 'Screen sharing did not start on this phone.' });
  }
}

export function stopScreenShare(): Promise<void> {
  return running?.manager.stopScreenShare() ?? Promise.resolve();
}

/**
 * The camera effects this phone offers (ADR 0038): all of them on Android, face ones included
 * (Android's own face detector); none on a build without the effects processor.
 */
export function effectChoices(): VideoEffect[] {
  if (Platform.OS !== 'android' || !PingdostCalls?.setVideoEffect) return [];
  return availableEffects({ faceTracking: true });
}

/** Draws `id` on this side's camera picture for the rest of the call ('none' to stop). */
export function setVideoEffect(id: string): void {
  const effect = videoEffect(id);
  PingdostCalls?.setVideoEffect?.(
    effect ? id : 'none',
    effect ? effectFragmentShader(effect) : '',
    effect?.face ?? false,
  );
  useCalls.setState({ effect: effect ? id : 'none' });
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
