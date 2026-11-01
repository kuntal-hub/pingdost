/**
 * What the call manager needs from a platform (ADR 0028). The peer is the W3C
 * `RTCPeerConnection` subset that browsers and react-native-webrtc both implement; the
 * platform owns local media (it opens the microphone and camera and adds the tracks) and maps
 * its connection events onto `PeerEvents`.
 */
import type { CallSignalData, IncomingCallSignal } from '@pingdost/protocol';

export interface SessionDescription {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

/** `RTCIceCandidateInit`. */
export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** `RTCIceServer`, as the server's TURN credentials route returns it. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** What a call's peer connection reports. */
export type PeerConnectionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface PeerEvents {
  /** A gathered local candidate; null when gathering is complete. */
  onIceCandidate(candidate: IceCandidate | null): void;
  onConnectionState(state: PeerConnectionState): void;
}

export interface CallPeer {
  createOffer(options?: { iceRestart?: boolean }): Promise<SessionDescription>;
  createAnswer(): Promise<SessionDescription>;
  setLocalDescription(description: SessionDescription): Promise<void>;
  setRemoteDescription(description: SessionDescription): Promise<void>;
  addIceCandidate(candidate: IceCandidate): Promise<void>;
  /** Browsers add gathered candidates to it, so a re-sent offer carries them. */
  readonly localDescription: SessionDescription | null;
  readonly signalingState: string;
  /** Turns the outgoing microphone track off or on. */
  setMuted(muted: boolean): void;
  /** Turns the outgoing camera track off or on (video calls). */
  setCameraOff(off: boolean): void;
  /** Stops local media and closes the connection. */
  close(): void;
}

export interface PeerOptions {
  iceServers: IceServer[];
  /** "Force relay (TURN)": `iceTransportPolicy: 'relay'`. */
  relayOnly: boolean;
  video: boolean;
}

/** Thrown by `createPeer` when the microphone or camera cannot be opened. */
export class CallMediaError extends Error {
  constructor(
    readonly reason: 'denied' | 'unavailable',
    message = reason === 'denied'
      ? 'Microphone or camera permission was denied'
      : 'No microphone or camera is available',
  ) {
    super(message);
    this.name = 'CallMediaError';
  }
}

export interface CallPlatform {
  /** Short-lived TURN credentials plus STUN (`GET /v1/calls/turn-credentials`). */
  iceServers(): Promise<IceServer[]>;
  /** Opens local media and a peer connection with its tracks; may throw `CallMediaError`. */
  createPeer(options: PeerOptions, events: PeerEvents): Promise<CallPeer>;
}

/** The message engine's call signaling, or a follower tab's proxy to it. */
export interface CallSignaling {
  devices(userId: string): Promise<string[]>;
  send(
    userId: string,
    deviceId: string,
    signal: CallSignalData,
  ): Promise<{ ok: true } | { ok: false; code: string; retryable: boolean }>;
  onSignal(listener: (signal: IncomingCallSignal) => void): () => void;
}
