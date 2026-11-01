// @pingdost/call-engine: one-to-one WebRTC calls (REQ §12, ADR 0028), shared by the web and
// Android apps: the call state machine and the `CallManager` over E2EE ephemeral signaling.
// Platforms supply the peer connection and media (`CallPlatform`).
export { CallError, CallManager, DEFAULT_CALL_SETTINGS } from './manager';
export type {
  CallErrorReason,
  CallManagerOptions,
  CallSettings,
  CallSnapshot,
  IncomingPolicy,
} from './manager';
export { isLive, isUnanswered, LIVE_STATES, transition } from './machine';
export type { CallContext, CallEvent, CallState, Transition } from './machine';
export { CallMediaError } from './types';
export type {
  CallPeer,
  CallPlatform,
  CallSignaling,
  IceCandidate,
  IceServer,
  PeerConnectionState,
  PeerEvents,
  PeerOptions,
  SessionDescription,
} from './types';
export type { CallOutcome, CallSignalData, IncomingCallSignal } from '@pingdost/protocol';
