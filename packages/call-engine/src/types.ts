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
  /** The system or browser stopped the screen sharing (its own "Stop sharing", app closed). */
  onScreenShareEnded(): void;
}

/**
 * The camera of a call (ADR 0037): `preview` is open for the self view only (while asking to
 * switch to video), `on` is sent. `off` closes it.
 */
export type CameraState = 'off' | 'preview' | 'on';

/**
 * What the user chose to share: one app or window (Android 14+ lets the user pick an app; a
 * browser preselects windows), or the whole screen.
 */
export type ScreenSurface = 'app' | 'screen';

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
  /**
   * Opens, sends or closes the camera on the call's video sender (ADR 0037). Throws
   * `CallMediaError` when the camera cannot be opened. A shared screen keeps the sender.
   */
  setCamera(state: CameraState): Promise<void>;
  /**
   * Starts sharing `surface` in place of the camera, or stops (null; the camera comes back if
   * it is on). Asks the user through the system or browser picker; throws `CallMediaError`
   * ('denied') when they cancel. Must run straight from the user's tap (browsers require it).
   */
  setScreenShare(surface: ScreenSurface | null): Promise<void>;
  /**
   * The connection carries video both ways (a negotiated send-and-receive video section), so
   * the call can switch to video or share a screen. False with an older app on the other side.
   */
  readonly canVideo: boolean;
  /** Stops local media and closes the connection. */
  close(): void;
}

export interface PeerOptions {
  iceServers: IceServer[];
  /** "Force relay (TURN)": `iceTransportPolicy: 'relay'`. */
  relayOnly: boolean;
  /**
   * The call starts as a video call: the camera opens with the microphone. Either way the
   * connection gets a send-and-receive video section, so the call can switch later.
   */
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
