// The browser's call platform (ADR 0028): getUserMedia and RTCPeerConnection under the shared
// call manager. It opens the microphone (and camera), adds the tracks, reports candidates and
// connection states, and hands the local and remote streams to the call UI. One call at a time.
import {
  CallMediaError,
  type CallPeer,
  type CallPlatform,
  type IceServer,
} from '@pingdost/call-engine';

import { callPrefs } from './prefs';
import { testMediaStream } from './test-media';

export interface MediaListener {
  (media: { local: MediaStream | null; remote: MediaStream | null }): void;
}

/** How the connected call's media flows, from the selected ICE candidate pair. */
export interface CallPath {
  /**
   * Media goes through TURN: a relay candidate was selected, or relaying was forced (then the
   * browser can send no other way, even when it names the pair's local side peer-reflexive).
   */
  relayed: boolean;
  /** The local candidate's type: host, srflx (STUN) or relay (TURN). */
  localType: string;
  remoteType: string;
  protocol: string;
  bytesSent: number;
  bytesReceived: number;
}

function mediaError(error: unknown): CallMediaError {
  const name = error instanceof DOMException ? error.name : '';
  return name === 'NotAllowedError' || name === 'SecurityError'
    ? new CallMediaError('denied')
    : new CallMediaError('unavailable');
}

export class WebCallPlatform implements CallPlatform {
  #pc: RTCPeerConnection | null = null;
  #relayOnly = false;
  #local: MediaStream | null = null;
  #remote: MediaStream | null = null;
  #stopTestMedia: (() => void) | undefined;

  constructor(
    private readonly fetchIceServers: () => Promise<IceServer[]>,
    private readonly onMedia: MediaListener,
  ) {}

  iceServers(): Promise<IceServer[]> {
    return this.fetchIceServers();
  }

  async createPeer(
    options: Parameters<CallPlatform['createPeer']>[0],
    events: Parameters<CallPlatform['createPeer']>[1],
  ): Promise<CallPeer> {
    const stream = await this.#openMedia(options.video);
    const pc = new RTCPeerConnection({
      iceServers: options.iceServers,
      iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
    });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const remote = new MediaStream();
    pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (!remote.getTracks().includes(track)) remote.addTrack(track);
      }
      this.#emit();
    };
    pc.onicecandidate = (event) => events.onIceCandidate(event.candidate?.toJSON() ?? null);
    pc.onconnectionstatechange = () => events.onConnectionState(pc.connectionState);
    this.#pc = pc;
    this.#relayOnly = options.relayOnly;
    this.#local = stream;
    this.#remote = remote;
    this.#emit();

    const close = () => {
      if (this.#pc !== pc) return;
      pc.close();
      for (const track of stream.getTracks()) track.stop();
      this.#stopTestMedia?.();
      this.#stopTestMedia = undefined;
      this.#pc = null;
      this.#local = null;
      this.#remote = null;
      this.#emit();
    };
    const setEnabled = (kind: 'audio' | 'video', enabled: boolean) => {
      for (const track of this.#local?.getTracks() ?? []) {
        if (track.kind === kind) track.enabled = enabled;
      }
    };
    return {
      createOffer: (offerOptions) => pc.createOffer(offerOptions ?? {}),
      createAnswer: () => pc.createAnswer(),
      setLocalDescription: (description) => pc.setLocalDescription(description),
      setRemoteDescription: (description) => pc.setRemoteDescription(description),
      addIceCandidate: (candidate) => pc.addIceCandidate(candidate),
      get localDescription() {
        return pc.localDescription;
      },
      get signalingState() {
        return pc.signalingState;
      },
      setMuted: (muted) => setEnabled('audio', !muted),
      setCameraOff: (off) => setEnabled('video', !off),
      close,
    };
  }

  /** Switches the microphone or camera of the live call. */
  async switchInput(kind: 'microphone' | 'camera', deviceId: string): Promise<void> {
    callPrefs.setDevice(kind, deviceId);
    const pc = this.#pc;
    const local = this.#local;
    if (!pc || !local || callPrefs.testMedia()) return;
    const trackKind = kind === 'microphone' ? 'audio' : 'video';
    const old = local.getTracks().find((t) => t.kind === trackKind);
    if (!old) return;
    const fresh = await navigator.mediaDevices.getUserMedia(
      trackKind === 'audio'
        ? { audio: { deviceId: { exact: deviceId } } }
        : { video: { deviceId: { exact: deviceId } } },
    );
    const track = fresh.getTracks()[0];
    if (!track) return;
    track.enabled = old.enabled;
    await pc
      .getSenders()
      .find((s) => s.track === old)
      ?.replaceTrack(track);
    local.removeTrack(old);
    old.stop();
    local.addTrack(track);
    this.#emit();
  }

  /** The selected candidate pair's types and the bytes moved so far; null before connected. */
  async path(): Promise<CallPath | null> {
    const pc = this.#pc;
    if (!pc) return null;
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((report: { type: string; selectedCandidatePairId?: string }) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        pairId = report.selectedCandidatePairId;
      }
    });
    type Pair = {
      type: string;
      id: string;
      selected?: boolean;
      nominated?: boolean;
      state?: string;
      localCandidateId: string;
      remoteCandidateId: string;
      bytesSent?: number;
      bytesReceived?: number;
    };
    let pair: Pair | undefined;
    stats.forEach((report: Pair) => {
      if (report.type !== 'candidate-pair') return;
      // Chrome names it on the transport; Firefox marks the pair itself.
      if (report.id === pairId || (!pairId && report.selected)) pair = report;
    });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId) as
      { candidateType?: string; protocol?: string; relayProtocol?: string } | undefined;
    const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
    const localType = local?.candidateType ?? 'unknown';
    const remoteType = remote?.candidateType ?? 'unknown';
    return {
      relayed: this.#relayOnly || localType === 'relay' || remoteType === 'relay',
      localType,
      remoteType,
      protocol: local?.relayProtocol ?? local?.protocol ?? 'unknown',
      bytesSent: pair.bytesSent ?? 0,
      bytesReceived: pair.bytesReceived ?? 0,
    };
  }

  async #openMedia(video: boolean): Promise<MediaStream> {
    if (callPrefs.testMedia()) {
      const test = testMediaStream(video);
      this.#stopTestMedia = test.stop;
      return test.stream;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new CallMediaError('unavailable');
    const microphone = callPrefs.device('microphone');
    const camera = callPrefs.device('camera');
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: microphone ? { deviceId: { ideal: microphone } } : true,
        video: video
          ? {
              ...(camera ? { deviceId: { ideal: camera } } : {}),
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
      });
    } catch (error) {
      throw mediaError(error);
    }
  }

  #emit(): void {
    this.onMedia({ local: this.#local, remote: this.#remote });
  }
}
