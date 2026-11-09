// The browser's call platform (ADR 0028, 0037): getUserMedia, getDisplayMedia and
// RTCPeerConnection under the shared call manager. One call at a time.
// - Every call has one audio and one send-and-receive video section. A voice call's video
//   sender starts empty, so the call can switch to video or share a screen with
//   `replaceTrack`, without renegotiating.
// - The video sender carries the shared screen if there is one, else the camera while it is
//   on, else nothing. The camera is closed whenever it is not in use.
// - Screen sharing never offers this PingDost tab itself (`selfBrowserSurface: 'exclude'`): no
//   chats in the share and no mirror of the call.
// - Camera effects (ADR 0038): once the user picks one, the camera runs through
//   `CameraEffects` and its output track stands in for the camera on the sender and the self
//   view for the rest of the call.
import {
  CallMediaError,
  videoEffect,
  type CameraState,
  type CallPeer,
  type CallPlatform,
  type IceServer,
  type PeerEvents,
  type ScreenSurface,
  type VideoEffect,
} from '@pingdost/call-engine';

import { CameraEffects, webEffects } from './effects';
import { callPrefs } from './prefs';
import { testMediaStream, testVideoTrack } from './test-media';

export interface CallMedia {
  /** The camera's self view (null while the camera is closed). */
  local: MediaStream | null;
  /** The other side's sound and picture. */
  remote: MediaStream | null;
  /** This tab's shared screen, for its own preview. */
  screen: MediaStream | null;
  /** The self view comes from a front camera (shown mirrored), as far as the browser says. */
  mirrorSelf: boolean;
}

export type MediaListener = (media: CallMedia) => void;

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

/** Screen Capture options newer than TypeScript's DOM types. */
interface ScreenShareOptions extends DisplayMediaStreamOptions {
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
}

/**
 * What the browser's picker offers for the user's choice: windows (an app) or whole screens,
 * never this tab. Choosing "one app" leaves whole screens out of the picker.
 */
export function displayMediaOptions(surface: ScreenSurface): ScreenShareOptions {
  return {
    video: {
      displaySurface: surface === 'screen' ? 'monitor' : 'window',
      frameRate: { ideal: 15, max: 30 },
    },
    audio: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: surface === 'screen' ? 'include' : 'exclude',
  };
}

function mediaError(error: unknown): CallMediaError {
  const name = error instanceof DOMException ? error.name : '';
  return name === 'NotAllowedError' || name === 'SecurityError'
    ? new CallMediaError('denied')
    : new CallMediaError('unavailable');
}

function cameraConstraints(deviceId: string | null, exact = false): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: exact ? { exact: deviceId } : { ideal: deviceId } } : {}),
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
}

/** One call's connection and local media. */
class Session {
  readonly remote = new MediaStream();
  camera: MediaStreamTrack | null = null;
  cameraState: CameraState = 'off';
  /** "Camera off" in a video call: the track stays but sends black. */
  cameraDisabled = false;
  screen: MediaStreamTrack | null = null;
  view: MediaStream | null = null;
  screenView: MediaStream | null = null;
  /** The camera through the chosen effect, once one was chosen. */
  effects: CameraEffects | null = null;
  closed = false;
  readonly stops: (() => void)[] = [];
  /** Camera changes run one after another (preview → on can follow quickly). */
  #cameraQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly pc: RTCPeerConnection,
    readonly mic: MediaStream,
    readonly relayOnly: boolean,
    readonly events: PeerEvents,
    readonly emit: () => void,
  ) {}

  videoTransceiver(): RTCRtpTransceiver | undefined {
    return this.pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
  }

  /** After a remote offer: answer the video section send-and-receive, so this side can switch. */
  allowVideoBothWays(): void {
    for (const t of this.pc.getTransceivers()) {
      if (t.receiver.track.kind === 'video' && t.direction === 'recvonly') t.direction = 'sendrecv';
    }
  }

  get canVideo(): boolean {
    return this.videoTransceiver()?.currentDirection === 'sendrecv';
  }

  /** What the camera sends: through the effects when there are any. */
  get cameraOut(): MediaStreamTrack | null {
    return this.camera ? (this.effects?.track ?? this.camera) : null;
  }

  async updateSender(): Promise<void> {
    const sender = this.videoTransceiver()?.sender;
    if (!sender || this.closed) return;
    const track = this.screen ?? (this.cameraState === 'on' ? this.cameraOut : null);
    if (sender.track !== track) await sender.replaceTrack(track);
  }

  setCameraTrack(track: MediaStreamTrack | null): void {
    const old = this.camera;
    this.camera = track;
    this.effects?.setSource(track);
    const out = this.cameraOut;
    this.view = out ? new MediaStream([out]) : null;
    if (old && old !== track) old.stop();
  }

  /** Draws `effect` on the camera from now on (null: the picture as it is). */
  async setEffect(effect: VideoEffect | null): Promise<void> {
    if (this.closed) return;
    if (effect && !this.effects) {
      this.effects = new CameraEffects();
      this.effects.setSource(this.camera);
      const out = this.cameraOut;
      this.view = out ? new MediaStream([out]) : null;
    }
    this.effects?.setEffect(effect);
    await this.updateSender();
    this.emit();
  }

  async openCamera(): Promise<MediaStreamTrack> {
    if (this.camera?.readyState === 'live') return this.camera;
    if (callPrefs.testMedia()) {
      const test = testVideoTrack('Test camera');
      this.stops.push(test.stop);
      return test.track;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new CallMediaError('unavailable');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: cameraConstraints(callPrefs.device('camera')),
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new CallMediaError('unavailable');
      return track;
    } catch (error) {
      throw error instanceof CallMediaError ? error : mediaError(error);
    }
  }

  setCamera(state: CameraState): Promise<void> {
    const run = this.#cameraQueue.then(async () => {
      if (this.closed) return;
      if (state === 'off') {
        this.cameraState = 'off';
        await this.updateSender();
        this.setCameraTrack(null);
        this.emit();
        return;
      }
      const track = await this.openCamera();
      if (this.closed) {
        track.stop();
        return;
      }
      if (track !== this.camera) this.setCameraTrack(track);
      this.cameraState = state;
      track.enabled = state === 'preview' || !this.cameraDisabled;
      await this.updateSender();
      this.emit();
    });
    this.#cameraQueue = run.catch(() => undefined);
    return run;
  }

  async setScreenShare(surface: ScreenSurface | null): Promise<void> {
    if (!surface) {
      this.stopScreen();
      await this.updateSender();
      this.emit();
      return;
    }
    let track: MediaStreamTrack | undefined;
    if (callPrefs.testMedia()) {
      const test = testVideoTrack(surface === 'screen' ? 'Test screen' : 'Test app');
      this.stops.push(test.stop);
      track = test.track;
    } else {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new CallMediaError('unavailable');
      try {
        // Straight from the user's tap: browsers require it for the picker.
        const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(surface));
        track = stream.getVideoTracks()[0];
      } catch (error) {
        throw mediaError(error);
      }
    }
    if (!track) throw new CallMediaError('unavailable');
    if (this.closed) {
      track.stop();
      return;
    }
    // Text and lines stay sharp rather than smooth.
    track.contentHint = 'detail';
    const shared = track;
    shared.addEventListener('ended', () => {
      // The browser's own "Stop sharing", or the shared window closed.
      if (this.screen !== shared) return;
      this.screen = null;
      this.screenView = null;
      void this.updateSender().finally(() => this.emit());
      this.events.onScreenShareEnded();
    });
    this.stopScreen();
    this.screen = shared;
    this.screenView = new MediaStream([shared]);
    await this.updateSender();
    this.emit();
  }

  stopScreen(): void {
    const screen = this.screen;
    this.screen = null;
    this.screenView = null;
    screen?.stop();
  }

  close(): void {
    this.closed = true;
    this.pc.close();
    for (const track of this.mic.getTracks()) track.stop();
    this.setCameraTrack(null);
    this.effects?.stop();
    this.effects = null;
    this.stopScreen();
    for (const stop of this.stops.splice(0)) stop();
  }
}

export class WebCallPlatform implements CallPlatform {
  #session: Session | null = null;

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
    const { stream, stop } = await this.#openMedia(options.video);
    const pc = new RTCPeerConnection({
      iceServers: options.iceServers,
      iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
    });
    const mic = new MediaStream(stream.getAudioTracks());
    const session = new Session(pc, mic, options.relayOnly, events, () => this.#emit(session));
    if (stop) session.stops.push(stop);
    for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
    const camera = stream.getVideoTracks()[0];
    if (camera) {
      session.setCameraTrack(camera);
      session.cameraState = 'on';
      pc.addTrack(camera, mic);
    }
    pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (!session.remote.getTracks().includes(track)) session.remote.addTrack(track);
      }
      this.#emit(session);
    };
    pc.onicecandidate = (event) => events.onIceCandidate(event.candidate?.toJSON() ?? null);
    pc.onconnectionstatechange = () => events.onConnectionState(pc.connectionState);
    this.#session = session;
    this.#emit(session);

    return {
      createOffer: (offerOptions) => {
        // Calling out with voice only: an empty video sender, so the call can switch later.
        if (!session.videoTransceiver()) {
          pc.addTransceiver('video', { direction: 'sendrecv', streams: [mic] });
        }
        return pc.createOffer(offerOptions ?? {});
      },
      createAnswer: () => pc.createAnswer(),
      setLocalDescription: (description) => pc.setLocalDescription(description),
      setRemoteDescription: async (description) => {
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') session.allowVideoBothWays();
      },
      addIceCandidate: (candidate) => pc.addIceCandidate(candidate),
      get localDescription() {
        return pc.localDescription;
      },
      get signalingState() {
        return pc.signalingState;
      },
      get canVideo() {
        return session.canVideo;
      },
      setMuted: (muted) => {
        for (const track of mic.getAudioTracks()) track.enabled = !muted;
      },
      setCameraOff: (off) => {
        session.cameraDisabled = off;
        if (session.camera && session.cameraState === 'on') session.camera.enabled = !off;
      },
      setCamera: (state) => session.setCamera(state),
      setScreenShare: (surface) => session.setScreenShare(surface),
      close: () => {
        if (session.closed) return;
        session.close();
        if (this.#session === session) this.#session = null;
        this.onMedia({ local: null, remote: null, screen: null, mirrorSelf: true });
      },
    };
  }

  /** Switches the microphone or camera of the live call. */
  async switchInput(kind: 'microphone' | 'camera', deviceId: string): Promise<void> {
    callPrefs.setDevice(kind, deviceId);
    const session = this.#session;
    if (!session || session.closed || callPrefs.testMedia()) return;
    if (kind === 'camera') {
      if (!session.camera) return;
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: cameraConstraints(deviceId, true),
      });
      const track = fresh.getVideoTracks()[0];
      if (!track || session.closed) {
        track?.stop();
        return;
      }
      track.enabled = session.camera.enabled;
      session.setCameraTrack(track);
      await session.updateSender();
      this.#emit(session);
      return;
    }
    const old = session.mic.getAudioTracks()[0];
    if (!old) return;
    const fresh = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
    });
    const track = fresh.getAudioTracks()[0];
    if (!track) return;
    track.enabled = old.enabled;
    await session.pc
      .getSenders()
      .find((s) => s.track === old)
      ?.replaceTrack(track);
    session.mic.removeTrack(old);
    old.stop();
    session.mic.addTrack(track);
  }

  /** Camera effects this browser can draw (ADR 0038). */
  effects(): VideoEffect[] {
    return webEffects();
  }

  /** Draws the effect `id` on the live call's camera ('none': the picture as it is). */
  async setEffect(id: string): Promise<void> {
    await this.#session?.setEffect(videoEffect(id) ?? null);
  }

  /** The cameras this browser can use (the flip button shows with two or more). */
  async cameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => []);
    return (devices ?? []).filter((d) => d.kind === 'videoinput' && d.deviceId !== '');
  }

  /** The next camera (front ↔ back on a phone, or the next webcam). */
  async flipCamera(): Promise<void> {
    const camera = this.#session?.camera;
    if (!camera) return;
    const cameras = await this.cameras();
    if (cameras.length < 2) return;
    const current = cameras.findIndex((c) => c.deviceId === camera.getSettings().deviceId);
    const next = cameras[(current + 1) % cameras.length]!;
    await this.switchInput('camera', next.deviceId);
  }

  /** The selected candidate pair's types and the bytes moved so far; null before connected. */
  async path(): Promise<CallPath | null> {
    const session = this.#session;
    if (!session) return null;
    const stats = await session.pc.getStats();
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
      relayed: session.relayOnly || localType === 'relay' || remoteType === 'relay',
      localType,
      remoteType,
      protocol: local?.relayProtocol ?? local?.protocol ?? 'unknown',
      bytesSent: pair.bytesSent ?? 0,
      bytesReceived: pair.bytesReceived ?? 0,
    };
  }

  async #openMedia(video: boolean): Promise<{ stream: MediaStream; stop?: () => void }> {
    if (callPrefs.testMedia()) return testMediaStream(video);
    if (!navigator.mediaDevices?.getUserMedia) throw new CallMediaError('unavailable');
    const microphone = callPrefs.device('microphone');
    try {
      // One prompt for both when the call starts with video.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: microphone ? { deviceId: { ideal: microphone } } : true,
        video: video ? cameraConstraints(callPrefs.device('camera')) : false,
      });
      return { stream };
    } catch (error) {
      throw mediaError(error);
    }
  }

  #emit(session: Session): void {
    if (this.#session !== session) return;
    const facing = session.camera?.getSettings().facingMode;
    this.onMedia({
      local: session.view,
      remote: session.remote,
      screen: session.screenView,
      mirrorSelf: facing !== 'environment',
    });
  }
}
