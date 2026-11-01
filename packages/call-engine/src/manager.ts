/**
 * One device's calls (REQ §12, ADR 0028): at most one at a time. Platform-neutral: the
 * signaling is the message engine's E2EE ephemeral channel, the media a `CallPlatform`.
 *
 * - The caller invites every device of the callee with the same offer. Devices that are
 *   offline get it again every `offerResendMs` (the server rings them with a content-free
 *   push) until the ring timeout. The first answer wins; the other devices get a hang-up
 *   ("answered elsewhere"). A reject or busy from any device ends the call.
 * - ICE candidates trickle in batches. Each device's candidates wait until it has the offer
 *   (caller) or the answer (callee); remote candidates wait for the remote description.
 * - Glare: two users who call each other at once keep the call with the lower ID; the other
 *   caller hangs up its own ("replaced") and answers that one.
 * - Only the caller makes offers. A lost connection (or a network change) restarts ICE from
 *   the caller; the callee asks for it. No connection within the timeouts ends the call.
 * - Signals name both call devices and are checked against the sender; late or duplicate
 *   signals for another or an ended call are ignored.
 */
import {
  uuidv7,
  type CallOutcome,
  type CallSignalData,
  type IncomingCallSignal,
} from '@pingdost/protocol';

import { isLive, isUnanswered, transition, type CallEvent, type CallState } from './machine';
import {
  CallMediaError,
  type CallPeer,
  type CallPlatform,
  type CallSignaling,
  type IceCandidate,
  type PeerConnectionState,
} from './types';

export interface CallSettings {
  /** The caller gives up, and an invite lapses, after this long. */
  ringTimeoutMs: number;
  /** Offline callee devices get the invite again this often. */
  offerResendMs: number;
  /** From the answer to connected media. */
  connectTimeoutMs: number;
  /** From a lost connection to giving up. */
  reconnectTimeoutMs: number;
  /** A lost connection that does not come back by itself this fast gets an ICE restart. */
  restartDelayMs: number;
  /** Local candidates gathered within this window travel in one signal. */
  candidateBatchMs: number;
  /** A signal that could not be relayed (e.g. the socket is reconnecting) is tried again. */
  signalRetryMs: number;
  /** How long a hang-up or reject keeps being tried. */
  finalSignalRetryWindowMs: number;
}

export const DEFAULT_CALL_SETTINGS: CallSettings = {
  ringTimeoutMs: 45_000,
  offerResendMs: 3_000,
  connectTimeoutMs: 30_000,
  reconnectTimeoutMs: 30_000,
  restartDelayMs: 2_000,
  candidateBatchMs: 40,
  signalRetryMs: 1_000,
  finalSignalRetryWindowMs: 10_000,
};

export type CallErrorReason =
  'media_denied' | 'media_unavailable' | 'no_devices' | 'unreachable' | 'connection' | 'signaling';

export interface CallSnapshot {
  callId: string;
  peerUserId: string;
  /** The other side's call device once known: the caller's, or the callee's that answered. */
  peerDeviceId: string | null;
  direction: 'in' | 'out';
  video: boolean;
  state: CallState;
  outcome: CallOutcome | null;
  error: CallErrorReason | null;
  startedAt: number;
  answeredAt: number | null;
  connectedAt: number | null;
  endedAt: number | null;
  muted: boolean;
  cameraOff: boolean;
  remoteMuted: boolean;
  remoteCameraOff: boolean;
  /** "Force relay (TURN)" was on for this call. */
  relayOnly: boolean;
}

/** What to do with an invite while this manager has no call. */
export type IncomingPolicy = 'ring' | 'busy' | 'ignore';

export interface CallManagerOptions {
  self: { userId: string; deviceId: string };
  signaling: CallSignaling;
  platform: CallPlatform;
  settings?: Partial<CallSettings>;
  /** E.g. another browser tab has a call ('ignore': it answers busy itself), a GSM call ('busy'). */
  incomingPolicy?: (signal: IncomingCallSignal) => IncomingPolicy | Promise<IncomingPolicy>;
  /** "Force relay (TURN)" (a debug setting), read when each call starts. */
  relayOnly?: () => boolean;
  /** Every call that ended (for the local call history). */
  onEnded?: (call: CallSnapshot) => void;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class CallError extends Error {
  constructor(
    readonly code: 'busy' | 'self',
    message: string,
  ) {
    super(message);
    this.name = 'CallError';
  }
}

interface Target {
  deviceId: string;
  /** It has the offer (caller) or the answer (callee): candidates may follow. */
  delivered: boolean;
  dead: boolean;
  /** Local candidates (JSON) waiting for `delivered`. */
  queue: string[];
}

interface Active {
  snap: CallSnapshot;
  everConnected: boolean;
  peer: CallPeer | null;
  /** Caller: the callee's devices (one after the answer). Callee: the caller's device. */
  targets: Map<string, Target>;
  /** Callee: the invite. */
  offer: CallSignalData | null;
  remoteDescription: boolean;
  /** Remote candidates per device, until the remote description is set. */
  remoteBuffer: Map<string, IceCandidate[]>;
  /** Local candidates gathered in the current batch window. */
  batch: string[];
  /** Every local candidate so far (a target added later starts with them). */
  gathered: string[];
  timers: Set<ReturnType<typeof setTimeout>>;
  connectTimer?: ReturnType<typeof setTimeout>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  batchTimer?: ReturnType<typeof setTimeout>;
  lastRestartAskAt: number;
}

/** Call IDs remembered after the call ended, so late signals for them are ignored. */
const ENDED_MEMORY = 64;

export class CallManager {
  readonly #o: CallManagerOptions;
  readonly #settings: CallSettings;
  readonly #listeners = new Set<(call: CallSnapshot | null) => void>();
  readonly #ended: string[] = [];
  #active: Active | null = null;
  #last: CallSnapshot | null = null;
  readonly #unsubscribe: () => void;
  /** Incoming signals are handled one at a time, in order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: CallManagerOptions) {
    this.#o = options;
    this.#settings = { ...DEFAULT_CALL_SETTINGS, ...options.settings };
    this.#unsubscribe = options.signaling.onSignal((signal) => {
      this.#queue = this.#queue
        .then(() => this.#onSignal(signal))
        .catch((error: unknown) => this.#log('signal failed', { error: String(error) }));
    });
  }

  /** The live call, or the one that ended last (until `clearEnded`). */
  get call(): CallSnapshot | null {
    return this.#active ? { ...this.#active.snap } : this.#last;
  }

  get busy(): boolean {
    return this.#active !== null;
  }

  onChange(listener: (call: CallSnapshot | null) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Resolves when the signals received so far are handled (tests). */
  idle(): Promise<void> {
    return this.#queue;
  }

  /** Forgets the ended call shown in the UI. */
  clearEnded(): void {
    if (this.#active || !this.#last) return;
    this.#last = null;
    this.#emit();
  }

  /** Calls `peerUserId` on every device; throws `CallError('busy')` while a call is live. */
  async dial(peerUserId: string, options: { video: boolean }): Promise<CallSnapshot> {
    const { self, signaling, platform } = this.#o;
    if (peerUserId === self.userId) throw new CallError('self', 'cannot call yourself');
    if (this.#active) throw new CallError('busy', 'already in a call');
    const active = this.#start({
      callId: uuidv7(),
      peerUserId,
      peerDeviceId: null,
      direction: 'out',
      video: options.video,
    });
    if (!this.#apply(active, { type: 'dial' })) throw new Error('unreachable');
    const [devices, iceServers] = await Promise.all([
      signaling.devices(peerUserId).catch(() => [] as string[]),
      platform.iceServers().catch(() => []),
    ]);
    if (!this.#current(active)) return { ...active.snap };
    if (devices.length === 0) {
      this.#fail(active, 'no_devices');
      return { ...active.snap };
    }
    const peer = await this.#openPeer(active, iceServers);
    if (!peer) return { ...active.snap };
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
    } catch (error) {
      this.#log('offer failed', { error: String(error) });
      this.#fail(active, 'connection');
      return { ...active.snap };
    }
    if (!this.#current(active)) return { ...active.snap };
    for (const deviceId of devices) {
      active.targets.set(deviceId, {
        deviceId,
        delivered: false,
        dead: false,
        queue: [...active.gathered],
      });
    }
    this.#after(active, this.#deadline(active) - this.#now(), () => this.#ringTimeout(active));
    for (const target of active.targets.values()) void this.#sendOffer(active, target);
    return { ...active.snap };
  }

  /** Answers the ringing call on this device. */
  async accept(): Promise<void> {
    const active = this.#active;
    if (!active?.offer || active.snap.state !== 'incoming') return;
    const offer = active.offer;
    if (!this.#apply(active, { type: 'accept' })) return;
    active.snap.answeredAt = this.#now();
    this.#startConnectTimer(active);
    this.#emit();
    const iceServers = await this.#o.platform.iceServers().catch(() => []);
    if (!this.#current(active)) return;
    const peer = await this.#openPeer(active, iceServers);
    if (!peer) return;
    let sdp: string;
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp! });
      active.remoteDescription = true;
      // Not awaited: a slow candidate (e.g. an mDNS name to resolve) must not hold the answer.
      this.#applyBuffered(active, offer.callerDeviceId);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sdp = peer.localDescription?.sdp ?? answer.sdp ?? '';
    } catch (error) {
      this.#log('answer failed', { error: String(error) });
      this.#fail(active, 'connection');
      return;
    }
    if (!this.#current(active)) return;
    const target = active.targets.get(offer.callerDeviceId)!;
    const sent = await this.#sendReliable(
      active,
      target.deviceId,
      {
        ...this.#ids(active, offer.callerDeviceId),
        type: 'answer',
        sdp,
        video: active.snap.video,
        muted: active.snap.muted,
        cameraOff: active.snap.cameraOff,
      },
      active.snap.answeredAt + this.#settings.connectTimeoutMs,
    );
    if (!this.#current(active)) return;
    if (!sent) {
      this.#fail(active, 'signaling');
      return;
    }
    target.delivered = true;
    this.#flushCandidates(active);
  }

  /** Declines the ringing call (every device of the caller stops calling). */
  async reject(): Promise<void> {
    const active = this.#active;
    if (active?.snap.state !== 'incoming' || !active.offer) return;
    const callerDevice = active.offer.callerDeviceId;
    this.#end(active, { type: 'reject_local' });
    await this.#sendFinal(active, callerDevice, {
      ...this.#ids(active, callerDevice),
      type: 'reject',
    });
  }

  /** Ends or cancels the call (declines it while it rings here). */
  async hangup(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (active.snap.state === 'incoming') {
      await this.reject();
      return;
    }
    const devices = [...active.targets.values()].filter(
      (t) => t.delivered || active.snap.direction === 'in',
    );
    this.#end(active, { type: 'hangup_local' });
    await Promise.all(
      devices.map((t) =>
        this.#sendFinal(active, t.deviceId, {
          ...this.#ids(active, t.deviceId),
          type: 'hangup',
          reason: 'normal',
        }),
      ),
    );
  }

  setMuted(muted: boolean): void {
    const active = this.#active;
    if (!active || active.snap.muted === muted) return;
    active.snap.muted = muted;
    active.peer?.setMuted(muted);
    this.#emit();
    this.#sendMediaState(active);
  }

  setCameraOff(off: boolean): void {
    const active = this.#active;
    if (!active || active.snap.cameraOff === off) return;
    active.snap.cameraOff = off;
    active.peer?.setCameraOff(off);
    this.#emit();
    this.#sendMediaState(active);
  }

  /** The device switched networks (Wi-Fi ↔ mobile, or came back online): restart ICE now. */
  networkChanged(): void {
    const active = this.#active;
    if (!active?.peer || !active.remoteDescription) return;
    const { state } = active.snap;
    if (state !== 'connected' && state !== 'reconnecting') return;
    if (state === 'connected') this.#apply(active, { type: 'disconnected' });
    this.#startReconnectTimer(active);
    this.#emit();
    void this.#restartIce(active);
  }

  /** Another tab (or the app's other UI) took this incoming call: stop ringing here. */
  dismiss(callId: string): void {
    const active = this.#active;
    if (active?.snap.callId === callId) this.#end(active, { type: 'dismissed' });
  }

  /** Hangs up any call and stops listening. */
  async dispose(): Promise<void> {
    this.#unsubscribe();
    await this.hangup().catch(() => undefined);
    this.#listeners.clear();
  }

  // Incoming signals

  async #onSignal({ fromUserId, fromDeviceId, signal }: IncomingCallSignal): Promise<void> {
    const { self } = this.#o;
    if (signal.type === 'offer') {
      if (signal.callerDeviceId !== fromDeviceId || signal.calleeDeviceId !== self.deviceId) return;
      await this.#onOffer({ fromUserId, fromDeviceId, signal });
      return;
    }
    const active = this.#active;
    if (!active || active.snap.callId !== signal.callId || active.snap.peerUserId !== fromUserId) {
      return;
    }
    const fromCallee =
      signal.calleeDeviceId === fromDeviceId && signal.callerDeviceId === self.deviceId;
    const fromCaller =
      signal.callerDeviceId === fromDeviceId && signal.calleeDeviceId === self.deviceId;
    if (active.snap.direction === 'out' ? !fromCallee : !fromCaller) return;
    const target = active.targets.get(fromDeviceId);
    if (!target) {
      // A callee device that was told the call went elsewhere answers late: tell it again.
      if (signal.type === 'answer') {
        void this.#sendFinal(active, fromDeviceId, {
          ...this.#ids(active, fromDeviceId),
          type: 'hangup',
          reason: 'answered_elsewhere',
        });
      }
      return;
    }
    switch (signal.type) {
      case 'ringing':
        if (this.#apply(active, { type: 'ringing' })) this.#emit();
        break;
      case 'answer':
        await this.#onAnswer(active, fromDeviceId, signal);
        break;
      case 'reject':
      case 'busy':
        if (!isUnanswered(active.snap.state)) break;
        void this.#otherTargetsHangup(active, fromDeviceId, 'declined_elsewhere');
        this.#end(active, { type: signal.type === 'reject' ? 'reject_remote' : 'busy_remote' });
        break;
      case 'hangup': {
        const event: CallEvent = {
          type: 'hangup_remote',
          ...(signal.reason ? { reason: signal.reason } : {}),
        };
        if (active.snap.direction === 'out' && active.snap.peerDeviceId === null) {
          // One callee device dropped out (e.g. it could not open its microphone): the call
          // ends only when none is left.
          active.targets.delete(fromDeviceId);
          if (active.targets.size === 0) this.#end(active, event);
          break;
        }
        if (active.snap.peerDeviceId !== fromDeviceId) break;
        this.#end(active, event);
        break;
      }
      case 'ice':
        this.#onRemoteCandidates(active, fromDeviceId, signal.candidates ?? []);
        break;
      case 'renegotiate':
        await this.#onRenegotiate(active, fromDeviceId, signal);
        break;
      case 'media':
        active.snap.remoteMuted = signal.muted ?? false;
        active.snap.remoteCameraOff = signal.cameraOff ?? false;
        this.#emit();
        break;
      default:
        break;
    }
  }

  async #onOffer({ fromUserId, fromDeviceId, signal }: IncomingCallSignal): Promise<void> {
    const now = this.#now();
    if (signal.expiresAt !== undefined && signal.expiresAt <= now) return;
    if (this.#ended.includes(signal.callId)) return;
    const current = this.#active;
    if (current?.snap.callId === signal.callId) return; // the caller sent it again
    if (current) {
      const glare =
        current.snap.direction === 'out' &&
        current.snap.peerUserId === fromUserId &&
        isUnanswered(current.snap.state);
      if (glare) {
        // The call with the lower ID survives; the other caller gives way and answers it.
        if (signal.callId > current.snap.callId) return;
        const targets = [...current.targets.values()].filter((t) => t.delivered);
        this.#drop(current);
        void Promise.all(
          targets.map((t) =>
            this.#sendFinal(current, t.deviceId, {
              ...this.#ids(current, t.deviceId),
              type: 'hangup',
              reason: 'replaced',
            }),
          ),
        );
        // The surviving call is the other user's: its video setting holds on both sides.
        this.#ring(fromUserId, fromDeviceId, signal);
        void this.accept();
        return;
      }
      void this.#sendBusy(fromUserId, fromDeviceId, signal);
      return;
    }
    const policy = (await this.#o.incomingPolicy?.({ fromUserId, fromDeviceId, signal })) ?? 'ring';
    if (this.#active) return; // a call started meanwhile; its own offer will be answered
    if (policy === 'ignore') return;
    if (policy === 'busy') {
      void this.#sendBusy(fromUserId, fromDeviceId, signal);
      return;
    }
    const active = this.#ring(fromUserId, fromDeviceId, signal);
    void this.#sendReliable(
      active,
      fromDeviceId,
      { ...this.#ids(active, fromDeviceId), type: 'ringing' },
      now + 5_000,
    );
  }

  #sendBusy(userId: string, deviceId: string, offer: CallSignalData): Promise<void> {
    return this.#sendFinal(
      null,
      deviceId,
      {
        callId: offer.callId,
        type: 'busy',
        callerDeviceId: offer.callerDeviceId,
        calleeDeviceId: offer.calleeDeviceId,
      },
      userId,
    );
  }

  /** Makes `signal` the ringing incoming call. */
  #ring(fromUserId: string, fromDeviceId: string, signal: CallSignalData): Active {
    const active = this.#start({
      callId: signal.callId,
      peerUserId: fromUserId,
      peerDeviceId: fromDeviceId,
      direction: 'in',
      video: signal.video === true,
    });
    active.offer = signal;
    active.snap.remoteMuted = signal.muted ?? false;
    active.snap.remoteCameraOff = signal.cameraOff ?? false;
    active.targets.set(fromDeviceId, {
      deviceId: fromDeviceId,
      delivered: false,
      dead: false,
      queue: [],
    });
    this.#apply(active, { type: 'invite' });
    const lapse = Math.min(
      this.#settings.ringTimeoutMs,
      (signal.expiresAt ?? Number.POSITIVE_INFINITY) - this.#now(),
    );
    this.#after(active, lapse, () => this.#ringTimeout(active));
    this.#emit();
    return active;
  }

  async #onAnswer(active: Active, deviceId: string, signal: CallSignalData): Promise<void> {
    const peer = active.peer;
    if (!peer || !signal.sdp) return;
    if (isUnanswered(active.snap.state)) {
      // The first answer: this device takes the call, the others are told.
      if (!this.#apply(active, { type: 'answer' })) return;
      active.snap.peerDeviceId = deviceId;
      active.snap.answeredAt = this.#now();
      active.snap.remoteMuted = signal.muted ?? false;
      active.snap.remoteCameraOff = signal.cameraOff ?? false;
      this.#startConnectTimer(active);
      this.#emit();
      void this.#otherTargetsHangup(active, deviceId, 'answered_elsewhere');
      try {
        await peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        active.remoteDescription = true;
        this.#applyBuffered(active, deviceId);
      } catch (error) {
        this.#log('remote answer failed', { error: String(error) });
        this.#fail(active, 'connection');
      }
      return;
    }
    // The answer to an ICE restart.
    if (deviceId !== active.snap.peerDeviceId || peer.signalingState !== 'have-local-offer') return;
    try {
      await peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } catch (error) {
      this.#log('restart answer failed', { error: String(error) });
    }
  }

  async #onRenegotiate(active: Active, deviceId: string, signal: CallSignalData): Promise<void> {
    const peer = active.peer;
    if (!peer || !active.remoteDescription || deviceId !== active.snap.peerDeviceId) return;
    if (active.snap.direction === 'out') {
      // The callee lost the connection: only the caller makes offers.
      void this.#restartIce(active);
      return;
    }
    if (!signal.sdp) return;
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      void this.#sendReliable(
        active,
        deviceId,
        {
          ...this.#ids(active, deviceId),
          type: 'answer',
          sdp: peer.localDescription?.sdp ?? answer.sdp ?? '',
        },
        this.#now() + this.#settings.reconnectTimeoutMs,
      );
    } catch (error) {
      this.#log('renegotiation failed', { error: String(error) });
    }
  }

  #onRemoteCandidates(active: Active, deviceId: string, candidates: string[]): void {
    const parsed: IceCandidate[] = [];
    for (const json of candidates) {
      try {
        const value = JSON.parse(json) as unknown;
        if (value && typeof value === 'object') parsed.push(value);
      } catch {
        // Not a candidate: skipped.
      }
    }
    const isPeer = active.snap.peerDeviceId === deviceId;
    if (!active.peer || !active.remoteDescription || !isPeer) {
      const buffer = active.remoteBuffer.get(deviceId) ?? [];
      buffer.push(...parsed);
      active.remoteBuffer.set(deviceId, buffer.slice(-200));
      return;
    }
    // In the background and side by side: the signal queue goes on meanwhile.
    this.#addCandidates(active.peer, parsed);
  }

  #applyBuffered(active: Active, deviceId: string): void {
    const buffered = active.remoteBuffer.get(deviceId) ?? [];
    active.remoteBuffer.clear();
    if (active.peer) this.#addCandidates(active.peer, buffered);
  }

  #addCandidates(peer: CallPeer, candidates: IceCandidate[]): void {
    for (const candidate of candidates) void this.#addCandidate(peer, candidate);
  }

  async #addCandidate(peer: CallPeer, candidate: IceCandidate): Promise<void> {
    try {
      await peer.addIceCandidate(candidate);
    } catch (error) {
      // A candidate from an old ICE generation, or a duplicate.
      this.#log('candidate not added', { error: String(error) });
    }
  }

  // Peer events

  #onPeerState(active: Active, state: PeerConnectionState): void {
    if (!this.#current(active)) return;
    switch (state) {
      case 'connected':
        if (!this.#apply(active, { type: 'connected' })) return;
        if (!active.everConnected) active.snap.connectedAt = this.#now();
        active.everConnected = true;
        this.#clear(active, 'connectTimer');
        this.#clear(active, 'reconnectTimer');
        this.#clear(active, 'restartTimer');
        this.#emit();
        break;
      case 'disconnected':
        if (this.#apply(active, { type: 'disconnected' })) {
          this.#startReconnectTimer(active);
          this.#emit();
        }
        if (active.snap.state === 'reconnecting' && !active.restartTimer) {
          active.restartTimer = this.#after(active, this.#settings.restartDelayMs, () => {
            active.restartTimer = undefined;
            void this.#restartIce(active);
          });
        }
        break;
      case 'failed':
        if (active.snap.state === 'connecting') {
          this.#fail(active, 'connection');
          return;
        }
        if (this.#apply(active, { type: 'disconnected' })) {
          this.#startReconnectTimer(active);
          this.#emit();
        }
        if (active.snap.state === 'reconnecting') void this.#restartIce(active);
        break;
      default:
        break;
    }
  }

  #onLocalCandidate(active: Active, candidate: IceCandidate | null): void {
    if (!candidate?.candidate || !this.#current(active)) return;
    active.batch.push(JSON.stringify(candidate));
    if (active.batchTimer) return;
    active.batchTimer = this.#after(active, this.#settings.candidateBatchMs, () => {
      active.batchTimer = undefined;
      const batch = active.batch.splice(0);
      active.gathered.push(...batch);
      for (const target of active.targets.values()) {
        if (!target.dead) target.queue.push(...batch);
      }
      this.#flushCandidates(active);
    });
  }

  #flushCandidates(active: Active): void {
    for (const target of active.targets.values()) {
      if (!target.delivered || target.dead || target.queue.length === 0) continue;
      const candidates = target.queue.splice(0);
      void this.#sendReliable(
        active,
        target.deviceId,
        { ...this.#ids(active, target.deviceId), type: 'ice', candidates },
        this.#now() + this.#settings.connectTimeoutMs,
      );
    }
  }

  async #restartIce(active: Active): Promise<void> {
    const peer = active.peer;
    const deviceId = active.snap.peerDeviceId;
    if (!peer || !deviceId || !this.#current(active)) return;
    if (active.snap.direction === 'in') {
      const now = this.#now();
      if (now - active.lastRestartAskAt < this.#settings.restartDelayMs) return;
      active.lastRestartAskAt = now;
      await this.#sendReliable(
        active,
        deviceId,
        { ...this.#ids(active, deviceId), type: 'renegotiate' },
        now + this.#settings.reconnectTimeoutMs,
      );
      return;
    }
    if (peer.signalingState !== 'stable') return; // a restart is already under way
    try {
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      await this.#sendReliable(
        active,
        deviceId,
        {
          ...this.#ids(active, deviceId),
          type: 'renegotiate',
          sdp: peer.localDescription?.sdp ?? offer.sdp ?? '',
          iceRestart: true,
        },
        this.#now() + this.#settings.reconnectTimeoutMs,
      );
    } catch (error) {
      this.#log('ICE restart failed', { error: String(error) });
    }
  }

  // Sending

  async #sendOffer(active: Active, target: Target): Promise<void> {
    const peer = active.peer;
    if (!peer || !this.#current(active) || !isUnanswered(active.snap.state)) return;
    const result = await this.#trySend(active.snap.peerUserId, target.deviceId, {
      ...this.#ids(active, target.deviceId),
      type: 'offer',
      // Browsers add the gathered candidates to it, so a late device needs no trickle.
      sdp: peer.localDescription?.sdp ?? '',
      video: active.snap.video,
      expiresAt: this.#deadline(active),
      muted: active.snap.muted,
      cameraOff: active.snap.cameraOff,
    });
    if (!this.#current(active) || !isUnanswered(active.snap.state)) return;
    if (!active.targets.has(target.deviceId)) return;
    if (result.ok) {
      target.delivered = true;
      this.#flushCandidates(active);
      return;
    }
    if (!result.retryable) {
      target.dead = true;
      if ([...active.targets.values()].every((t) => t.dead)) this.#fail(active, 'unreachable');
      return;
    }
    // Offline (the server rang it): send it again until the ring timeout.
    if (this.#now() + this.#settings.offerResendMs < this.#deadline(active)) {
      this.#after(active, this.#settings.offerResendMs, () => void this.#sendOffer(active, target));
    }
  }

  /** One send; a throwing transport (e.g. the engine moving to another tab) is retryable. */
  async #trySend(
    userId: string,
    deviceId: string,
    signal: CallSignalData,
  ): Promise<{ ok: true } | { ok: false; code: string; retryable: boolean }> {
    try {
      return await this.#o.signaling.send(userId, deviceId, signal);
    } catch (error) {
      this.#log('signal send threw', { error: String(error) });
      return { ok: false, code: 'ERROR', retryable: true };
    }
  }

  /** Tries a signal of the live call until it is relayed or `until`. */
  async #sendReliable(
    active: Active,
    deviceId: string,
    signal: CallSignalData,
    until: number,
  ): Promise<boolean> {
    for (;;) {
      if (!this.#current(active)) return false;
      const result = await this.#trySend(active.snap.peerUserId, deviceId, signal);
      if (result.ok) return true;
      if (!result.retryable || this.#now() + this.#settings.signalRetryMs > until) return false;
      await this.#sleep(this.#settings.signalRetryMs);
    }
  }

  /** A hang-up, reject or busy: tried for a while even though the call has ended here. */
  async #sendFinal(
    active: Active | null,
    deviceId: string,
    signal: CallSignalData,
    peerUserId = active?.snap.peerUserId ?? '',
  ): Promise<void> {
    const until = this.#now() + this.#settings.finalSignalRetryWindowMs;
    for (;;) {
      const result = await this.#trySend(peerUserId, deviceId, signal);
      if (result.ok || !result.retryable) return;
      if (this.#now() + this.#settings.signalRetryMs > until) return;
      await this.#sleep(this.#settings.signalRetryMs);
    }
  }

  async #otherTargetsHangup(
    active: Active,
    keep: string,
    reason: 'answered_elsewhere' | 'declined_elsewhere',
  ): Promise<void> {
    const others = [...active.targets.values()].filter((t) => t.deviceId !== keep);
    for (const other of others) active.targets.delete(other.deviceId);
    await Promise.all(
      others
        .filter((t) => t.delivered)
        .map((t) =>
          this.#sendFinal(active, t.deviceId, {
            ...this.#ids(active, t.deviceId),
            type: 'hangup',
            reason,
          }),
        ),
    );
  }

  #sendMediaState(active: Active): void {
    const deviceId = active.snap.peerDeviceId;
    if (!deviceId || isUnanswered(active.snap.state)) return;
    void this.#sendReliable(
      active,
      deviceId,
      {
        ...this.#ids(active, deviceId),
        type: 'media',
        muted: active.snap.muted,
        cameraOff: active.snap.cameraOff,
      },
      this.#now() + 5_000,
    );
  }

  /** The caller and callee device IDs of a signal between this device and `deviceId`. */
  #ids(
    active: Active,
    deviceId: string,
  ): Pick<CallSignalData, 'callId' | 'callerDeviceId' | 'calleeDeviceId'> {
    const self = this.#o.self.deviceId;
    return active.snap.direction === 'out'
      ? { callId: active.snap.callId, callerDeviceId: self, calleeDeviceId: deviceId }
      : { callId: active.snap.callId, callerDeviceId: deviceId, calleeDeviceId: self };
  }

  // Lifecycle

  #start(
    fields: Pick<CallSnapshot, 'callId' | 'peerUserId' | 'peerDeviceId' | 'direction' | 'video'>,
  ): Active {
    const active: Active = {
      snap: {
        ...fields,
        state: 'idle',
        outcome: null,
        error: null,
        startedAt: this.#now(),
        answeredAt: null,
        connectedAt: null,
        endedAt: null,
        muted: false,
        cameraOff: false,
        remoteMuted: false,
        remoteCameraOff: false,
        relayOnly: this.#o.relayOnly?.() ?? false,
      },
      everConnected: false,
      peer: null,
      targets: new Map(),
      offer: null,
      remoteDescription: false,
      remoteBuffer: new Map(),
      batch: [],
      gathered: [],
      timers: new Set(),
      lastRestartAskAt: 0,
    };
    this.#active = active;
    this.#last = null;
    return active;
  }

  async #openPeer(
    active: Active,
    iceServers: Awaited<ReturnType<CallPlatform['iceServers']>>,
  ): Promise<CallPeer | undefined> {
    let peer: CallPeer;
    try {
      peer = await this.#o.platform.createPeer(
        { iceServers, relayOnly: active.snap.relayOnly, video: active.snap.video },
        {
          onIceCandidate: (candidate) => this.#onLocalCandidate(active, candidate),
          onConnectionState: (state) => this.#onPeerState(active, state),
        },
      );
    } catch (error) {
      const reason =
        error instanceof CallMediaError
          ? error.reason === 'denied'
            ? 'media_denied'
            : 'media_unavailable'
          : 'connection';
      this.#log('peer not opened', { reason });
      this.#fail(active, reason);
      return undefined;
    }
    if (!this.#current(active)) {
      peer.close();
      return undefined;
    }
    active.peer = peer;
    if (active.snap.muted) peer.setMuted(true);
    if (active.snap.cameraOff) peer.setCameraOff(true);
    return peer;
  }

  #ringTimeout(active: Active): void {
    if (!this.#current(active) || !isUnanswered(active.snap.state)) return;
    const notify =
      active.snap.direction === 'out'
        ? [...active.targets.values()].filter((t) => t.delivered)
        : [];
    this.#end(active, { type: 'ring_timeout' });
    for (const target of notify) {
      void this.#sendFinal(active, target.deviceId, {
        ...this.#ids(active, target.deviceId),
        type: 'hangup',
        reason: 'no_answer',
      });
    }
  }

  #startConnectTimer(active: Active): void {
    this.#clear(active, 'connectTimer');
    active.connectTimer = this.#after(active, this.#settings.connectTimeoutMs, () => {
      if (active.snap.state === 'connecting') this.#fail(active, 'connection');
    });
  }

  #startReconnectTimer(active: Active): void {
    if (active.reconnectTimer) return;
    active.reconnectTimer = this.#after(active, this.#settings.reconnectTimeoutMs, () => {
      if (active.snap.state === 'reconnecting') this.#fail(active, 'connection');
    });
  }

  /** Ends the call as failed and tells the other side. */
  #fail(active: Active, error: CallErrorReason): void {
    if (!this.#current(active)) return;
    active.snap.error = error;
    const devices =
      active.snap.peerDeviceId !== null
        ? [active.snap.peerDeviceId]
        : [...active.targets.values()].filter((t) => t.delivered).map((t) => t.deviceId);
    this.#end(active, { type: 'failure' });
    for (const deviceId of devices) {
      void this.#sendFinal(active, deviceId, {
        ...this.#ids(active, deviceId),
        type: 'hangup',
        reason: 'failed',
      });
    }
  }

  /** Applies a transition to the live call; false when it does not apply. */
  #apply(active: Active, event: CallEvent): boolean {
    const next = transition(
      {
        state: active.snap.state,
        direction: active.snap.direction,
        everConnected: active.everConnected,
      },
      event,
    );
    if (!next) return false;
    active.snap.state = next.state;
    if (next.outcome) active.snap.outcome = next.outcome;
    return true;
  }

  #end(active: Active, event: CallEvent): void {
    if (!this.#current(active) || !this.#apply(active, event) || active.snap.state !== 'ended') {
      return;
    }
    active.snap.endedAt = this.#now();
    this.#teardown(active);
    this.#last = { ...active.snap };
    this.#emit();
    try {
      this.#o.onEnded?.({ ...active.snap });
    } catch (error) {
      this.#log('onEnded failed', { error: String(error) });
    }
  }

  /** Drops the live call without an outcome (it was replaced in glare). */
  #drop(active: Active): void {
    if (!this.#current(active)) return;
    this.#teardown(active);
  }

  #teardown(active: Active): void {
    for (const timer of active.timers) clearTimeout(timer);
    active.timers.clear();
    active.peer?.close();
    active.peer = null;
    this.#ended.push(active.snap.callId);
    if (this.#ended.length > ENDED_MEMORY) this.#ended.shift();
    if (this.#active === active) this.#active = null;
  }

  #current(active: Active): boolean {
    return this.#active === active && isLive(active.snap.state);
  }

  #deadline(active: Active): number {
    return active.snap.startedAt + this.#settings.ringTimeoutMs;
  }

  #after(active: Active, ms: number, run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(
      () => {
        active.timers.delete(timer);
        run();
      },
      Math.max(0, ms),
    );
    active.timers.add(timer);
    return timer;
  }

  #clear(active: Active, key: 'connectTimer' | 'reconnectTimer' | 'restartTimer'): void {
    const timer = active[key];
    if (timer === undefined) return;
    clearTimeout(timer);
    active.timers.delete(timer);
    active[key] = undefined;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #emit(): void {
    const call = this.call;
    for (const listener of [...this.#listeners]) {
      try {
        listener(call);
      } catch (error) {
        this.#log('listener failed', { error: String(error) });
      }
    }
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  #log(message: string, fields?: Record<string, unknown>): void {
    this.#o.log?.(message, fields);
  }
}
