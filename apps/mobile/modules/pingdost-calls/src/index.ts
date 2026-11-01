// The local `PingdostCalls` Expo module (modules/pingdost-calls, Kotlin; Phase 26, ADR 0029):
// the incoming-call notification (full-screen intent, ringtone), the `phoneCall` foreground
// service, audio routing, the proximity screen-off and the lock-screen window flags. WebRTC
// itself is react-native-webrtc. Android only.
import { requireOptionalNativeModule, type NativeModule } from 'expo';

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

type PingdostCallsModule = NativeModule<CallsEvents> & Omit<CallsNative, 'addListener'>;

/** Null in a build made before the module existed (rebuild the dev client), and on iOS/web. */
export const PingdostCalls = requireOptionalNativeModule<PingdostCallsModule>('PingdostCalls') as
  (PingdostCallsModule & CallsNative) | null;
