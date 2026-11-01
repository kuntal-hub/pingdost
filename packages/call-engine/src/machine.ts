/**
 * The call state machine shared by every platform (REQ §12.2, ADR 0028). Pure: the manager
 * feeds it events and acts on the result.
 *
 *   idle ─dial→ outgoing ─ringing→ ringing ─answer→ connecting ─connected→ connected
 *   idle ─invite→ incoming ─accept→ connecting      connected ⇄ reconnecting
 *   any live state ─(hang-up, reject, busy, timeout, failure)→ ended(outcome)
 */
import type { CallHangupReason, CallOutcome } from '@pingdost/protocol';

export type CallState =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended';

export type CallEvent =
  /** This device starts a call. */
  | { type: 'dial' }
  /** An invite arrived for this device. */
  | { type: 'invite' }
  /** A callee device says it is ringing. */
  | { type: 'ringing' }
  /** The user accepted the incoming call here. */
  | { type: 'accept' }
  /** The caller got an answer from one callee device. */
  | { type: 'answer' }
  /** Media flows (ICE connected). */
  | { type: 'connected' }
  /** ICE lost the connection, or the network changed. */
  | { type: 'disconnected' }
  | { type: 'hangup_local' }
  | { type: 'hangup_remote'; reason?: CallHangupReason }
  | { type: 'reject_local' }
  | { type: 'reject_remote' }
  | { type: 'busy_remote' }
  /** Nobody answered (caller), or the invite lapsed (callee). */
  | { type: 'ring_timeout' }
  /** Could not connect, or reconnect, in time; media or signaling failed. */
  | { type: 'failure' }
  /** Another tab or part of this device took the incoming call. */
  | { type: 'dismissed' };

export interface CallContext {
  state: CallState;
  direction: 'in' | 'out';
  /** The call was connected at some point. */
  everConnected: boolean;
}

export interface Transition {
  state: CallState;
  /** Set when the call ended. */
  outcome?: CallOutcome;
}

/** States in which a call exists (anything but idle and ended). */
export const LIVE_STATES: readonly CallState[] = [
  'outgoing',
  'incoming',
  'ringing',
  'connecting',
  'connected',
  'reconnecting',
];

export function isLive(state: CallState): boolean {
  return LIVE_STATES.includes(state);
}

/** Before an answer: the caller is still inviting, the callee still ringing. */
export function isUnanswered(state: CallState): boolean {
  return state === 'outgoing' || state === 'ringing' || state === 'incoming';
}

function ended(outcome: CallOutcome): Transition {
  return { state: 'ended', outcome };
}

/**
 * The next state for `event`, or undefined when the event does not apply in this state (the
 * manager then ignores it: a late or duplicate signal).
 */
export function transition(context: CallContext, event: CallEvent): Transition | undefined {
  const { state, direction, everConnected } = context;
  switch (event.type) {
    case 'dial':
      return state === 'idle' || state === 'ended' ? { state: 'outgoing' } : undefined;
    case 'invite':
      return state === 'idle' || state === 'ended' ? { state: 'incoming' } : undefined;
    case 'ringing':
      return state === 'outgoing' ? { state: 'ringing' } : undefined;
    case 'accept':
      return state === 'incoming' ? { state: 'connecting' } : undefined;
    case 'answer':
      return state === 'outgoing' || state === 'ringing' ? { state: 'connecting' } : undefined;
    case 'connected':
      return state === 'connecting' || state === 'reconnecting'
        ? { state: 'connected' }
        : undefined;
    case 'disconnected':
      return state === 'connected' ? { state: 'reconnecting' } : undefined;
    case 'hangup_local':
      if (!isLive(state)) return undefined;
      if (state === 'incoming') return ended('rejected');
      return ended(everConnected ? 'completed' : 'cancelled');
    case 'hangup_remote': {
      if (!isLive(state)) return undefined;
      switch (event.reason) {
        case 'answered_elsewhere':
          return state === 'incoming' ? ended('answered_elsewhere') : undefined;
        case 'declined_elsewhere':
          return state === 'incoming' ? ended('declined_elsewhere') : undefined;
        case 'no_answer':
          return state === 'incoming' ? ended('missed') : undefined;
        case 'failed':
          return ended('failed');
        case 'replaced':
          return isUnanswered(state) ? ended('cancelled') : undefined;
        default:
          if (everConnected) return ended('completed');
          if (state === 'incoming') return ended('missed');
          return ended(direction === 'in' ? 'missed' : 'cancelled');
      }
    }
    case 'reject_local':
      return state === 'incoming' ? ended('rejected') : undefined;
    case 'reject_remote':
      return state === 'outgoing' || state === 'ringing' ? ended('rejected') : undefined;
    case 'busy_remote':
      return state === 'outgoing' || state === 'ringing' ? ended('busy') : undefined;
    case 'ring_timeout':
      if (state === 'incoming') return ended('missed');
      return state === 'outgoing' || state === 'ringing' ? ended('no_answer') : undefined;
    case 'failure':
      return isLive(state) ? ended('failed') : undefined;
    case 'dismissed':
      return state === 'incoming' ? ended('answered_elsewhere') : undefined;
  }
}
