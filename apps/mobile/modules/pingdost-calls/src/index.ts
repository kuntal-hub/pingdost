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
  action: 'decline' | 'hangup';
  callId: string;
}

type CallsEvents = {
  action: (event: CallAction) => void;
  audioRoutes: (event: AudioRoutes) => void;
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
