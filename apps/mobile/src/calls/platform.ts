// The Android call platform (ADR 0029, 0037): react-native-webrtc under the shared call
// manager. One call at a time.
// - Every call has one audio and one send-and-receive video section. A voice call's video
//   sender starts empty, so the call can switch to video or share the screen with
//   `replaceTrack`, without renegotiating.
// - The video sender carries the shared screen if there is one, else the camera while it is
//   on, else nothing. The camera is closed whenever it is not in use.
// - Screen sharing goes through Android's own consent dialog (MediaProjection); Android 14+
//   lets the user pick one app there. react-native-webrtc runs the `mediaProjection`
//   foreground service (turned on by the PingdostCalls module).
import { PermissionsAndroid, Platform } from 'react-native';
import {
  mediaDevices,
  MediaStream,
  RTCPeerConnection,
  type MediaStreamTrack,
  type RTCRtpTransceiver,
} from 'react-native-webrtc';

import {
  CallMediaError,
  type CameraState,
  type CallPeer,
  type CallPlatform,
  type IceServer,
  type PeerEvents,
  type ScreenSurface,
} from '@pingdost/call-engine';

type SessionInit = { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string };

export interface CallMedia {
  /** The camera's self view (null while the camera is closed). */
  local: MediaStream | null;
  /** The other side's picture (their camera or screen); their sound plays by itself. */
  remote: MediaStream | null;
  /** The camera faces the user: the self view is mirrored. */
  front: boolean;
}

/** The phone model, to tell two phones apart in one Metro log (dev builds only). */
export function deviceTag(): string {
  const constants = Platform.constants as { Model?: string };
  return constants.Model ?? Platform.OS;
}

/**
 * A candidate without its addresses, for dev logs: protocol, type and the first characters of
 * its ICE username fragment (which ICE generation it belongs to).
 */
export function candidateSummary(candidate: string): string {
  const parts = candidate.split(' ');
  const typ = parts[parts.indexOf('typ') + 1] ?? '?';
  const ufragAt = parts.indexOf('ufrag');
  const ufrag = ufragAt >= 0 ? (parts[ufragAt + 1] ?? '').slice(0, 4) : '-';
  return `${(parts[2] ?? '?').toLowerCase()} ${typ} ${ufrag}`;
}

/** The ICE username fragment's first characters in an SDP (dev logs). */
function sdpUfrag(sdp: string | undefined): string {
  return /a=ice-ufrag:(\S{1,4})/.exec(sdp ?? '')?.[1] ?? '-';
}

const debug = __DEV__
  ? (message: string) => console.log(`[webrtc ${deviceTag()}] ${message}`)
  : undefined;

/** Asks for the microphone (and the camera); false when the user says no. */
export async function grantCallPermissions(video: boolean): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const wanted = [
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ...(video ? [PermissionsAndroid.PERMISSIONS.CAMERA] : []),
  ];
  const result = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((permission) => result[permission] === PermissionsAndroid.RESULTS.GRANTED);
}

/** react-native-webrtc rejects with `NotAllowedError` in the name or message on a "no". */
function mediaError(error: unknown): CallMediaError {
  const { name = '', message = '' } = (error ?? {}) as { name?: string; message?: string };
  return `${name} ${message}`.includes('NotAllowedError')
    ? new CallMediaError('denied')
    : new CallMediaError('unavailable');
}

function isVideo(transceiver: RTCRtpTransceiver): boolean {
  return transceiver.receiver.track?.kind === 'video' || transceiver.sender.track?.kind === 'video';
}

/** One call's connection and local media. */
class Session {
  remote: MediaStream | null = null;
  camera: MediaStream | null = null;
  cameraState: CameraState = 'off';
  /** "Camera off" in a video call: the capture stops, the track stays. */
  cameraDisabled = false;
  front = true;
  screen: MediaStream | null = null;
  closed = false;
  /** Camera changes run one after another (preview → on can follow quickly). */
  #cameraQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly pc: RTCPeerConnection,
    readonly mic: MediaStream,
    readonly events: PeerEvents,
    readonly emit: () => void,
  ) {}

  videoTransceiver(): RTCRtpTransceiver | undefined {
    return this.pc.getTransceivers().find(isVideo);
  }

  /** After a remote offer: answer the video section send-and-receive, so this side can switch. */
  allowVideoBothWays(): void {
    for (const t of this.pc.getTransceivers()) {
      if (isVideo(t) && t.direction === 'recvonly') t.direction = 'sendrecv';
    }
  }

  get canVideo(): boolean {
    return this.videoTransceiver()?.currentDirection === 'sendrecv';
  }

  get cameraTrack(): MediaStreamTrack | null {
    return this.camera?.getVideoTracks()[0] ?? null;
  }

  async updateSender(): Promise<void> {
    const sender = this.videoTransceiver()?.sender;
    if (!sender || this.closed) return;
    const track =
      this.screen?.getVideoTracks()[0] ?? (this.cameraState === 'on' ? this.cameraTrack : null);
    if (sender.track?.id !== track?.id) await sender.replaceTrack(track);
  }

  async openCamera(): Promise<MediaStream> {
    if (this.camera) return this.camera;
    try {
      return await mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: this.front ? 'user' : 'environment',
          width: 1280,
          height: 720,
          frameRate: 30,
        },
      });
    } catch (error) {
      throw mediaError(error);
    }
  }

  closeCamera(): void {
    const camera = this.camera;
    this.camera = null;
    if (!camera) return;
    for (const track of camera.getTracks()) track.stop();
    camera.release();
  }

  setCamera(state: CameraState): Promise<void> {
    const run = this.#cameraQueue.then(async () => {
      if (this.closed) return;
      if (state === 'off') {
        this.cameraState = 'off';
        await this.updateSender();
        this.closeCamera();
        this.emit();
        return;
      }
      const camera = await this.openCamera();
      if (this.closed) {
        for (const track of camera.getTracks()) track.stop();
        camera.release();
        return;
      }
      this.camera = camera;
      this.cameraState = state;
      const track = this.cameraTrack;
      if (track) track.enabled = state === 'preview' || !this.cameraDisabled;
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
    let screen: MediaStream;
    try {
      // Android's consent dialog. "Entire screen" asks for the whole display only (Android
      // 14+); otherwise Android 14+ lets the user pick one app there.
      screen = await mediaDevices.getDisplayMedia({
        android: { createConfigForDefaultDisplay: surface === 'screen' },
      });
    } catch (error) {
      throw mediaError(error);
    }
    const track = screen.getVideoTracks()[0];
    if (!track || this.closed) {
      for (const t of screen.getTracks()) t.stop();
      screen.release();
      if (!track) throw new CallMediaError('unavailable');
      return;
    }
    track.addEventListener('ended', () => {
      // Android's own "Stop sharing" (status bar chip, notification) or the shared app closed.
      if (this.screen !== screen) return;
      this.stopScreen();
      void this.updateSender().finally(() => this.emit());
      this.events.onScreenShareEnded();
    });
    this.stopScreen();
    this.screen = screen;
    await this.updateSender();
    this.emit();
  }

  stopScreen(): void {
    const screen = this.screen;
    this.screen = null;
    if (!screen) return;
    for (const track of screen.getTracks()) track.stop();
    screen.release();
  }

  close(): void {
    this.closed = true;
    for (const track of this.mic.getTracks()) track.stop();
    this.closeCamera();
    this.stopScreen();
    this.pc.close();
  }
}

export class NativeCallPlatform implements CallPlatform {
  #session: Session | null = null;

  constructor(
    private readonly fetchIceServers: () => Promise<IceServer[]>,
    private readonly onMedia: (media: CallMedia) => void,
  ) {}

  iceServers(): Promise<IceServer[]> {
    return this.fetchIceServers();
  }

  async createPeer(
    options: Parameters<CallPlatform['createPeer']>[0],
    events: Parameters<CallPlatform['createPeer']>[1],
  ): Promise<CallPeer> {
    if (!(await grantCallPermissions(options.video))) throw new CallMediaError('denied');
    let mic: MediaStream;
    try {
      mic = await mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      throw mediaError(error);
    }
    const pc = new RTCPeerConnection({
      iceServers: options.iceServers,
      iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
    });
    const session = new Session(pc, mic, events, () => this.#emit(session));
    for (const track of mic.getTracks()) pc.addTrack(track, mic);
    if (options.video) {
      try {
        await session.setCamera('on');
      } catch (error) {
        session.close();
        throw error;
      }
      const camera = session.cameraTrack;
      if (camera) pc.addTrack(camera, mic);
    }
    pc.addEventListener('track', (event) => {
      if (event.track?.kind !== 'video') return;
      // The other side's camera or screen. A sender added mid-call may name no stream.
      const stream = event.streams[0];
      session.remote = stream?.getVideoTracks().length ? stream : new MediaStream([event.track]);
      this.#emit(session);
    });
    if (debug) {
      pc.addEventListener('iceconnectionstatechange', () => debug(`ice ${pc.iceConnectionState}`));
      pc.addEventListener('icegatheringstatechange', () =>
        debug(`gathering ${pc.iceGatheringState}`),
      );
      pc.addEventListener('connectionstatechange', () => debug(`connection ${pc.connectionState}`));
    }
    pc.addEventListener('icecandidate', (event) => {
      const candidate = event.candidate;
      if (candidate) debug?.(`local ${candidateSummary(candidate.candidate)}`);
      events.onIceCandidate(
        candidate
          ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid ?? null,
              sdpMLineIndex: candidate.sdpMLineIndex ?? null,
            }
          : null,
      );
    });
    pc.addEventListener('connectionstatechange', () => {
      events.onConnectionState(pc.connectionState);
    });
    this.#session = session;
    this.#emit(session);

    return {
      createOffer: async (offerOptions) => {
        // Calling out with voice only: an empty video sender, so the call can switch later.
        if (!session.videoTransceiver()) {
          pc.addTransceiver('video', { direction: 'sendrecv', streams: [mic] });
        }
        return (await pc.createOffer(offerOptions ?? {})) as SessionInit;
      },
      createAnswer: async () => (await pc.createAnswer()) as SessionInit,
      setLocalDescription: (description) => {
        debug?.(`set local ${description.type} ufrag ${sdpUfrag(description.sdp)}`);
        return pc.setLocalDescription(description as never);
      },
      setRemoteDescription: async (description) => {
        debug?.(`set remote ${description.type} ufrag ${sdpUfrag(description.sdp)}`);
        await pc.setRemoteDescription(description as never);
        if (description.type === 'offer') session.allowVideoBothWays();
      },
      addIceCandidate: (candidate) => {
        if (candidate.candidate) debug?.(`remote ${candidateSummary(candidate.candidate)}`);
        return pc.addIceCandidate(candidate);
      },
      get localDescription() {
        const local = pc.localDescription;
        return local ? { type: local.type as SessionInit['type'], sdp: local.sdp } : null;
      },
      get signalingState() {
        return pc.signalingState;
      },
      get canVideo() {
        return session.canVideo;
      },
      setMuted: (muted) => {
        for (const track of mic.getTracks()) track.enabled = !muted;
      },
      setCameraOff: (off) => {
        session.cameraDisabled = off;
        const camera = session.cameraTrack;
        if (camera && session.cameraState === 'on') camera.enabled = !off;
      },
      setCamera: (state) => session.setCamera(state),
      setScreenShare: (surface) => session.setScreenShare(surface),
      close: () => {
        if (session.closed) return;
        session.close();
        if (this.#session === session) this.#session = null;
        this.onMedia({ local: null, remote: null, front: true });
      },
    };
  }

  /** Front ↔ back camera of the live video call. */
  async switchCamera(): Promise<void> {
    const session = this.#session;
    const track = session?.cameraTrack;
    if (!session || !track) return;
    session.front = !session.front;
    try {
      await track.applyConstraints({ facingMode: session.front ? 'user' : 'environment' });
    } catch {
      track._switchCamera();
    }
    this.#emit(session);
  }

  #emit(session: Session): void {
    if (this.#session !== session || session.closed) return;
    this.onMedia({ local: session.camera, remote: session.remote, front: session.front });
  }
}
