/**
 * Test doubles for the call manager (ADR 0028):
 * - `FakeSignalingHub`: devices of several users relay `CallSignalData` to each other, like the
 *   server's ephemeral relay (RECIPIENT_OFFLINE for a device that is not online).
 * - `FakeRtcNetwork`: peers that connect only once offer, answer and each side's candidates
 *   (of the current ICE generation) really reached the other side, so a lost signal shows.
 *   `drop()` cuts connected pairs until an ICE restart; `blocked` keeps media from flowing;
 *   `requireRelay` connects only "Force relay" peers.
 */
import type { CallSignalData, IncomingCallSignal } from '@pingdost/protocol';

import {
  CallMediaError,
  type CallPeer,
  type CallPlatform,
  type CallSignaling,
  type IceCandidate,
  type IceServer,
  type PeerEvents,
  type PeerOptions,
  type SessionDescription,
} from './types';

interface HubDevice {
  userId: string;
  deviceId: string;
  online: boolean;
  listeners: Set<(signal: IncomingCallSignal) => void>;
}

export interface SentSignal {
  from: string;
  to: string;
  signal: CallSignalData;
  delivered: boolean;
}

export class FakeSignalingHub {
  readonly #devices = new Map<string, HubDevice>();
  /** Every send, delivered or not. */
  readonly sent: SentSignal[] = [];
  /** Drops a signal in transit when it returns false (answered as relayed). */
  filter: ((sent: SentSignal) => boolean) | undefined;

  /** Registers a device and returns its signaling. */
  device(userId: string, deviceId: string): CallSignaling {
    const device: HubDevice = { userId, deviceId, online: true, listeners: new Set() };
    this.#devices.set(deviceId, device);
    return {
      devices: (peerUserId) =>
        Promise.resolve(
          [...this.#devices.values()].filter((d) => d.userId === peerUserId).map((d) => d.deviceId),
        ),
      send: (peerUserId, to, signal) => {
        const sender = this.#devices.get(deviceId)!;
        const recipient = this.#devices.get(to);
        if (!sender.online) return Promise.resolve({ ok: false, code: 'OFFLINE', retryable: true });
        if (recipient?.userId !== peerUserId) {
          return Promise.resolve({ ok: false, code: 'UNKNOWN_DEVICE', retryable: false });
        }
        const sent: SentSignal = { from: deviceId, to, signal, delivered: recipient.online };
        this.sent.push(sent);
        if (!recipient.online) {
          return Promise.resolve({ ok: false, code: 'RECIPIENT_OFFLINE', retryable: true });
        }
        if (this.filter && !this.filter(sent)) return Promise.resolve({ ok: true });
        const message: IncomingCallSignal = {
          fromUserId: sender.userId,
          fromDeviceId: deviceId,
          signal: structuredClone(signal),
        };
        setTimeout(() => {
          if (!recipient.online) return;
          for (const listener of recipient.listeners) listener(message);
        }, 0);
        return Promise.resolve({ ok: true });
      },
      onSignal: (listener) => {
        device.listeners.add(listener);
        return () => {
          device.listeners.delete(listener);
        };
      },
    };
  }

  setOnline(deviceId: string, online: boolean): void {
    this.#devices.get(deviceId)!.online = online;
  }

  /** Injects a signal as if `fromDeviceId` of `fromUserId` sent it. */
  inject(to: string, message: IncomingCallSignal): void {
    for (const listener of this.#devices.get(to)?.listeners ?? []) listener(message);
  }

  count(type: CallSignalData['type'], to?: string): number {
    return this.sent.filter((s) => s.signal.type === type && (to === undefined || s.to === to))
      .length;
  }
}

type Signaling = 'stable' | 'have-local-offer' | 'have-remote-offer';

export class FakePeer implements CallPeer {
  localDescription: SessionDescription | null = null;
  remoteDescription: SessionDescription | null = null;
  signalingState: Signaling = 'stable';
  readonly remoteCandidates: IceCandidate[] = [];
  muted = false;
  cameraOff = false;
  closed = false;
  /** ICE generation: an ICE restart starts the next one. */
  generation = 1;
  partner: string | undefined;
  partnerGeneration = 0;
  connected = false;

  constructor(
    readonly id: string,
    readonly options: PeerOptions,
    readonly events: PeerEvents,
    private readonly network: FakeRtcNetwork,
  ) {}

  createOffer(options?: { iceRestart?: boolean }): Promise<SessionDescription> {
    if (options?.iceRestart) this.generation++;
    return Promise.resolve({ type: 'offer', sdp: `fake ${this.id} ${this.generation}` });
  }

  createAnswer(): Promise<SessionDescription> {
    if (this.signalingState !== 'have-remote-offer') {
      return Promise.reject(new Error('no remote offer'));
    }
    return Promise.resolve({ type: 'answer', sdp: `fake ${this.id} ${this.generation}` });
  }

  setLocalDescription(description: SessionDescription): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    const generation = this.generation;
    // Gathering: two candidates, then the end-of-candidates null.
    setTimeout(() => {
      if (this.closed) return;
      for (const n of [1, 2]) {
        this.events.onIceCandidate({
          candidate: `candidate:${this.id}:${generation}:${n}`,
          sdpMid: '0',
          sdpMLineIndex: 0,
        });
      }
      this.events.onIceCandidate(null);
    }, 1);
    this.network.check();
    return Promise.resolve();
  }

  setRemoteDescription(description: SessionDescription): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    const [, partner, generation] = (description.sdp ?? '').split(' ');
    this.remoteDescription = description;
    this.partner = partner;
    this.partnerGeneration = Number(generation);
    if (description.type === 'offer') {
      // An ICE restart offer moves this side to the same new generation.
      if (this.partnerGeneration > this.generation) this.generation = this.partnerGeneration;
      this.signalingState = 'have-remote-offer';
    } else {
      this.signalingState = 'stable';
    }
    this.network.check();
    return Promise.resolve();
  }

  addIceCandidate(candidate: IceCandidate): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    if (!this.remoteDescription) return Promise.reject(new Error('no remote description'));
    this.remoteCandidates.push(candidate);
    this.network.check();
    return Promise.resolve();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setCameraOff(off: boolean): void {
    this.cameraOff = off;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
  }

  /** Has a candidate of `peer`'s current generation. */
  hasCandidateOf(peer: FakePeer): boolean {
    return this.remoteCandidates.some((c) => {
      const [, id, generation] = (c.candidate ?? '').split(':');
      return id === peer.id && Number(generation) === peer.generation;
    });
  }

  emit(state: Parameters<PeerEvents['onConnectionState']>[0]): void {
    setTimeout(() => {
      if (!this.closed) this.events.onConnectionState(state);
    }, 0);
  }
}

export interface FakePlatform extends CallPlatform {
  readonly peers: FakePeer[];
  /** The next `createPeer` throws this. */
  mediaError: CallMediaError | undefined;
  iceServerList: IceServer[];
}

export class FakeRtcNetwork {
  readonly #peers = new Map<string, FakePeer>();
  #next = 0;
  /** Media cannot flow at all. */
  blocked = false;
  /** Only peers with "Force relay" connect. */
  requireRelay = false;

  platform(name: string): FakePlatform {
    const platform: FakePlatform = {
      peers: [],
      mediaError: undefined,
      iceServerList: [{ urls: 'turn:turn.test:3478', username: 'u', credential: 'c' }],
      iceServers: () => Promise.resolve(platform.iceServerList),
      createPeer: (options, events) => {
        if (platform.mediaError) {
          const error = platform.mediaError;
          platform.mediaError = undefined;
          return Promise.reject(error);
        }
        const peer = new FakePeer(`${name}#${++this.#next}`, options, events, this);
        this.#peers.set(peer.id, peer);
        platform.peers.push(peer);
        return Promise.resolve(peer);
      },
    };
    return platform;
  }

  /** Every connected pair loses its connection (both see 'disconnected'). */
  drop(): void {
    for (const peer of this.#peers.values()) {
      if (!peer.connected) continue;
      peer.connected = false;
      peer.emit('disconnected');
    }
  }

  /** Connects pairs whose descriptions and current candidates have reached each other. */
  check(): void {
    if (this.blocked) return;
    for (const a of this.#peers.values()) {
      const b = a.partner ? this.#peers.get(a.partner) : undefined;
      if (!b || a.closed || b.closed || a.connected || b.partner !== a.id) continue;
      if (a.signalingState !== 'stable' || b.signalingState !== 'stable') continue;
      if (a.generation !== b.generation) continue;
      if (!a.hasCandidateOf(b) || !b.hasCandidateOf(a)) continue;
      if (this.requireRelay && !(a.options.relayOnly && b.options.relayOnly)) continue;
      a.connected = true;
      b.connected = true;
      a.emit('connected');
      b.emit('connected');
    }
  }

  /** Fails every peer that is not connected (e.g. ICE gave up). */
  failPending(): void {
    for (const peer of this.#peers.values()) {
      if (!peer.connected && !peer.closed) peer.emit('failed');
    }
  }
}

export { CallMediaError };
