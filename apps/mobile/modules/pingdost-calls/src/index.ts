// The local `PingdostCalls` Expo module (modules/pingdost-calls). Android (Kotlin; Phase 26,
// ADR 0029): the incoming-call notification (full-screen intent, ringtone), the `phoneCall`
// foreground service, audio routing, the proximity screen-off and the lock-screen window flags.
// iOS (Swift; Phase 29, ADR 0032): PushKit VoIP pushes and CallKit, plus the same audio, proximity
// and screen functions; the notification and ringing functions are no-ops there. WebRTC itself is
// react-native-webrtc.
import { requireOptionalNativeModule, type NativeModule } from 'expo';

import type { CallKitEvent, CallKitNative } from '../../../src/calls/callkit';

export type AudioRoute = 'earpiece' | 'speaker' | 'headset' | 'bluetooth';

export interface AudioRoutes {
  available: AudioRoute[];
  current: AudioRoute | null;
}

export interface CallAction {
  /** `mute` / `unmute`: the picture-in-picture window's button (ADR 0037). */
  action: 'decline' | 'hangup' | 'mute' | 'unmute';
  callId: string;
}

type CallsEvents = {
  action: (event: CallAction) => void;
  audioRoutes: (event: AudioRoutes) => void;
  /** Android: PingDost's window became visible (started, PiP included) or not (stopped). */
  visibility: (event: { visible: boolean }) => void;
  /** iOS: CallKit actions, audio session changes and calls reported for VoIP pushes. */
  callkit: (event: CallKitEvent) => void;
  /** iOS: the PushKit VoIP token changed (null: invalidated). */
  voipToken: (event: { token: string | null }) => void;
};

export interface Subscription {
  remove(): void;
}

export interface CallsNative {
  addListener<E extends keyof CallsEvents>(event: E, listener: CallsEvents[E]): Subscription;
  takePendingActions(): CallAction[];
  showIncoming(callId: string, name: string, video: boolean): void;
  cancelIncoming(): void;
  startOngoing(callId: string, name: string, video: boolean): void;
  stopOngoing(): void;
  startAudio(video: boolean): void;
  stopAudio(): void;
  audioRoutes(): AudioRoutes;
  setAudioRoute(route: AudioRoute): boolean;
  setProximityScreenOff(on: boolean): void;
  startRinging(): void;
  stopRinging(): void;
  inSystemCall(): boolean;
  setKeepScreenOn(on: boolean): void;
  setShowWhenLocked(on: boolean): void;
  canUseFullScreenIntent(): boolean;
  openFullScreenIntentSettings(): void;
  // Android, ADR 0037. Optional: absent in builds made before them, and on iOS.
  /** The phone has picture-in-picture (Android 8+, not turned off by the maker). */
  pipSupported?(): boolean;
  /** Picture-in-picture when the user leaves the app, with Mute/Unmute and Hang up. */
  setPip?(enabled: boolean, muted: boolean, callId: string): void;
  isInPictureInPicture?(): boolean;
  /** Closes the picture-in-picture window (the call ended in it). */
  exitPip?(): void;
  /** PingDost's window can be seen (started; picture-in-picture counts). */
  isAppVisible?(): boolean;
  // Android, ADR 0038. Optional like the ones above.
  /** The react-native-webrtc video processor name every camera track should carry. */
  videoEffectsProcessor?(): string;
  /** The camera effect: its GLSL source and whether it tracks the face; "none" turns it off. */
  setVideoEffect?(id: string, shader: string, face: boolean): void;
}

/** iOS only: the CallKit and PushKit functions (absent on Android). */
export interface CallsNativeIos extends CallKitNative {
  voipToken(): string | null;
  /** CallKit events from before JS listened (answer on the lock screen, audio activation). */
  takePendingCallKitEvents(): CallKitEvent[];
}

type PingdostCallsModule = NativeModule<CallsEvents> &
  Omit<CallsNative, 'addListener'> &
  Partial<CallsNativeIos>;

/** Null in a build made before the module existed (rebuild the dev client), and on web. */
export const PingdostCalls = requireOptionalNativeModule<PingdostCallsModule>('PingdostCalls') as
  (PingdostCallsModule & CallsNative) | null;

/** The CallKit surface, when this build has it (iOS). */
export function callKitNative(): (CallsNative & CallsNativeIos) | null {
  const native = PingdostCalls;
  return native?.reportIncoming && native.takePendingCallKitEvents
    ? (native as CallsNative & CallsNativeIos)
    : null;
}
