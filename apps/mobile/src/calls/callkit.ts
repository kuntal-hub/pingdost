// iOS calls through CallKit (Phase 29, ADR 0032). Every incoming call on an iPhone is a CallKit
// call: iOS shows its own call screen (also over the lock screen), rings, and owns the audio
// session. This bridge keeps CallKit and the shared call manager in step. It is pure (no React
// Native), so it runs in unit tests against a fake native side.
//
// - A VoIP push (`{"t":"call"}`) carries no caller: the native module reports a call named
//   "PingDost" at once, as iOS requires for every VoIP push, and the app connects. When the E2EE
//   invite arrives, the bridge binds that call to it and updates the name and video flag. If no
//   invite comes in time (the caller gave up, or this phone answered busy), it ends the call.
// - An invite that arrives over an open socket is reported as a new incoming call.
// - Answer, decline, end and mute on the system screen come back as events.
// - Outgoing calls are reported to CallKit too, so iOS treats them as calls (audio, status bar).
import type { CallOutcome, CallSnapshot } from '@pingdost/call-engine';

/** Why a call ended, as CallKit is told (`CXCallEndedReason`, or a local end action). */
export type CallKitEndReason =
  'local' | 'remote' | 'unanswered' | 'failed' | 'answeredElsewhere' | 'declinedElsewhere';

/** The native module's CallKit surface (modules/pingdost-calls/ios). */
export interface CallKitNative {
  reportIncoming(uuid: string, name: string, video: boolean): void;
  updateCall(uuid: string, name: string, video: boolean): void;
  startOutgoing(uuid: string, name: string, video: boolean): void;
  reportConnected(uuid: string): void;
  endCall(uuid: string, reason: CallKitEndReason): void;
  /** A push call is now tied to an invite: stops the native safety timer. */
  bindPushCall(uuid: string): void;
  /** Calls reported for VoIP pushes and not yet bound or ended (oldest first). */
  pendingPushCalls(): string[];
}

export type CallKitEvent =
  | { type: 'push'; uuid: string }
  | { type: 'answer'; uuid: string }
  | { type: 'end'; uuid: string }
  | { type: 'mute'; uuid: string; muted: boolean }
  | { type: 'audio'; active: boolean };

export interface CallKitActions {
  accept(callId: string): void;
  reject(): void;
  hangup(): void;
  setMuted(muted: boolean): void;
  /** CallKit activated or deactivated the audio session (tell WebRTC). */
  audio(active: boolean): void;
}

export interface CallKitBridgeOptions {
  /** How long a push call waits for its invite (the caller re-sends it every 3 s). */
  inviteWaitMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** A UUID for invites whose call ID is not one (any peer can choose its call ID). */
  randomUuid: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How CallKit is told a call ended, when the end did not start on its own screen. */
export function endReasonFor(outcome: CallOutcome | null): CallKitEndReason {
  switch (outcome) {
    case 'completed':
    case 'rejected':
    case 'busy':
    case 'cancelled':
      return 'remote';
    case 'no_answer':
    case 'missed':
      return 'unanswered';
    case 'answered_elsewhere':
      return 'answeredElsewhere';
    case 'declined_elsewhere':
      return 'declinedElsewhere';
    default:
      return 'failed';
  }
}

interface Bound {
  uuid: string;
  name: string;
  video: boolean;
  connected: boolean;
}

interface PendingPush {
  uuid: string;
  timer: unknown;
  /** The user answered or declined on the CallKit screen before the invite arrived. */
  then?: 'answer' | 'decline';
}

export class CallKitBridge {
  readonly #bound = new Map<string, Bound>();
  readonly #pushes: PendingPush[] = [];
  /** Calls whose end CallKit already knows (ended on its screen, or by our end action). */
  readonly #endedInCallKit = new Set<string>();
  readonly #endedLocally = new Set<string>();
  readonly #inviteWaitMs: number;
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  #call: CallSnapshot | null = null;

  constructor(
    private readonly native: CallKitNative,
    private readonly actions: CallKitActions,
    private readonly options: CallKitBridgeOptions,
  ) {
    this.#inviteWaitMs = options.inviteWaitMs ?? 20_000;
    this.#setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.#clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    for (const uuid of native.pendingPushCalls()) this.#addPush(uuid.toLowerCase());
  }

  /** The CallKit UUID of a call, if it has one. */
  uuidOf(callId: string): string | undefined {
    return this.#bound.get(callId)?.uuid;
  }

  /** The user ended the call in the app (not on the CallKit screen). */
  endedLocally(callId: string): void {
    this.#endedLocally.add(callId);
  }

  /** Every change of the manager's call, with the name to show. */
  onCall(call: CallSnapshot | null, name: string): void {
    this.#call = call;
    if (!call) return;
    const bound = this.#bound.get(call.callId);
    if (call.state === 'ended') {
      if (bound) this.#end(call, bound);
      return;
    }
    if (!bound) {
      if (call.direction === 'in' && call.state === 'incoming') this.#incoming(call, name);
      else if (call.direction === 'out') this.#outgoing(call, name);
      return;
    }
    if ((bound.name !== name || bound.video !== call.video) && call.state === 'incoming') {
      bound.name = name;
      bound.video = call.video;
      this.native.updateCall(bound.uuid, name, call.video);
    }
    if (call.state === 'connected' && !bound.connected) {
      bound.connected = true;
      this.native.reportConnected(bound.uuid);
    }
  }

  onEvent(event: CallKitEvent): void {
    switch (event.type) {
      case 'push':
        this.#onPush(event.uuid.toLowerCase());
        return;
      case 'answer':
      case 'end':
        this.#onAction(event.type, event.uuid.toLowerCase());
        return;
      case 'mute':
        if (this.#callIdOf(event.uuid.toLowerCase())) this.actions.setMuted(event.muted);
        return;
      case 'audio':
        this.actions.audio(event.active);
        return;
    }
  }

  dispose(): void {
    for (const push of this.#pushes.splice(0)) this.#clearTimer(push.timer);
    this.#bound.clear();
  }

  #incoming(call: CallSnapshot, name: string): void {
    const push = this.#pushes.shift();
    if (push) {
      this.#clearTimer(push.timer);
      this.#bound.set(call.callId, { uuid: push.uuid, name, video: call.video, connected: false });
      if (push.then === 'decline') {
        // Declined on the CallKit screen before the invite came: CallKit has ended it.
        this.#endedInCallKit.add(push.uuid);
        this.actions.reject();
        return;
      }
      this.native.bindPushCall(push.uuid);
      this.native.updateCall(push.uuid, name, call.video);
      if (push.then === 'answer') this.actions.accept(call.callId);
      return;
    }
    const uuid = this.#uuidFor(call.callId);
    this.#bound.set(call.callId, { uuid, name, video: call.video, connected: false });
    this.native.reportIncoming(uuid, name, call.video);
  }

  /** CallKit wants a UUID: the call ID when it is one (ours are UUIDv7), else a random one. */
  #uuidFor(callId: string): string {
    return (UUID.test(callId) ? callId : this.options.randomUuid()).toLowerCase();
  }

  #outgoing(call: CallSnapshot, name: string): void {
    const uuid = this.#uuidFor(call.callId);
    this.#bound.set(call.callId, { uuid, name, video: call.video, connected: false });
    this.native.startOutgoing(uuid, name, call.video);
  }

  #end(call: CallSnapshot, bound: Bound): void {
    this.#bound.delete(call.callId);
    const local = this.#endedLocally.delete(call.callId);
    if (this.#endedInCallKit.delete(bound.uuid)) return;
    this.native.endCall(bound.uuid, local ? 'local' : endReasonFor(call.outcome));
  }

  #onPush(uuid: string): void {
    if (this.#pushes.some((push) => push.uuid === uuid)) return;
    if ([...this.#bound.values()].some((bound) => bound.uuid === uuid)) return;
    // A live call means this phone is online, so the push is stale or for a call the manager
    // will answer busy: end it now rather than show a second call screen.
    if (this.#call && this.#call.state !== 'ended') {
      this.native.endCall(uuid, 'remote');
      return;
    }
    this.#addPush(uuid);
  }

  #addPush(uuid: string): void {
    const push: PendingPush = {
      uuid,
      timer: this.#setTimer(() => {
        const at = this.#pushes.indexOf(push);
        if (at < 0) return;
        this.#pushes.splice(at, 1);
        // No invite came: the caller gave up, or this phone answered busy. A declined one
        // is over in CallKit already.
        if (push.then !== 'decline') this.native.endCall(uuid, 'unanswered');
      }, this.#inviteWaitMs),
    };
    this.#pushes.push(push);
  }

  #callIdOf(uuid: string): string | undefined {
    for (const [callId, bound] of this.#bound) if (bound.uuid === uuid) return callId;
    return undefined;
  }

  #onAction(action: 'answer' | 'end', uuid: string): void {
    const callId = this.#callIdOf(uuid);
    if (!callId) {
      const push = this.#pushes.find((pending) => pending.uuid === uuid);
      // Kept until its invite comes (then rejected without ringing again) or time runs out.
      if (push) push.then = action === 'answer' ? 'answer' : 'decline';
      return;
    }
    if (action === 'answer') {
      this.actions.accept(callId);
      return;
    }
    this.#endedInCallKit.add(uuid);
    if (this.#call?.callId === callId && this.#call.state === 'incoming') this.actions.reject();
    else this.actions.hangup();
  }
}
