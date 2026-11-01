// The Android call platform (ADR 0029): react-native-webrtc under the shared call manager. It
// opens the microphone (and the front camera for video), adds the tracks, reports candidates
// and connection states, and hands the streams to the call screen. One call at a time.
import { PermissionsAndroid, Platform } from 'react-native';
import { mediaDevices, RTCPeerConnection, type MediaStream } from 'react-native-webrtc';

import {
  CallMediaError,
  type CallPeer,
  type CallPlatform,
  type IceServer,
} from '@pingdost/call-engine';

type SessionInit = { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string };

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

export class NativeCallPlatform implements CallPlatform {
  #pc: RTCPeerConnection | null = null;
  #local: MediaStream | null = null;
  #front = true;

  constructor(
    private readonly fetchIceServers: () => Promise<IceServer[]>,
    private readonly onMedia: (media: {
      local: MediaStream | null;
      remote: MediaStream | null;
    }) => void,
  ) {}

  iceServers(): Promise<IceServer[]> {
    return this.fetchIceServers();
  }

  async createPeer(
    options: Parameters<CallPlatform['createPeer']>[0],
    events: Parameters<CallPlatform['createPeer']>[1],
  ): Promise<CallPeer> {
    if (!(await grantCallPermissions(options.video))) throw new CallMediaError('denied');
    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: true,
        video: options.video
          ? { facingMode: 'user', width: 1280, height: 720, frameRate: 30 }
          : false,
      });
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name ?? '';
      throw new CallMediaError(name === 'NotAllowedError' ? 'denied' : 'unavailable');
    }
    this.#front = true;
    const pc = new RTCPeerConnection({
      iceServers: options.iceServers,
      iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
    });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    let remote: MediaStream | null = null;
    pc.addEventListener('track', (event) => {
      remote = event.streams[0] ?? remote;
      this.onMedia({ local: stream, remote });
    });
    pc.addEventListener('icecandidate', (event) => {
      const candidate = event.candidate;
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
    this.#pc = pc;
    this.#local = stream;
    this.onMedia({ local: stream, remote: null });

    const setEnabled = (kind: 'audio' | 'video', enabled: boolean) => {
      for (const track of stream.getTracks()) if (track.kind === kind) track.enabled = enabled;
    };
    const close = () => {
      if (this.#pc !== pc) return;
      for (const track of stream.getTracks()) track.stop();
      pc.close();
      this.#pc = null;
      this.#local = null;
      this.onMedia({ local: null, remote: null });
    };
    return {
      createOffer: async (offerOptions) => {
        const offer = (await pc.createOffer(offerOptions ?? {})) as SessionInit;
        return offer;
      },
      createAnswer: async () => (await pc.createAnswer()) as SessionInit,
      setLocalDescription: (description) => pc.setLocalDescription(description as never),
      setRemoteDescription: (description) => pc.setRemoteDescription(description as never),
      addIceCandidate: (candidate) => pc.addIceCandidate(candidate),
      get localDescription() {
        const local = pc.localDescription;
        return local ? { type: local.type as SessionInit['type'], sdp: local.sdp } : null;
      },
      get signalingState() {
        return pc.signalingState;
      },
      setMuted: (muted) => setEnabled('audio', !muted),
      setCameraOff: (off) => setEnabled('video', !off),
      close,
    };
  }

  /** Front ↔ back camera of the live video call. */
  async switchCamera(): Promise<void> {
    const track = this.#local?.getVideoTracks()[0];
    if (!track) return;
    this.#front = !this.#front;
    try {
      await track.applyConstraints({ facingMode: this.#front ? 'user' : 'environment' });
    } catch {
      track._switchCamera();
    }
  }
}
