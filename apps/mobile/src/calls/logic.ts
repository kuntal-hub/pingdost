// Pure call helpers for the phone app (ADR 0029), kept apart from React Native so they run
// in unit tests: which call actions a chat offers, how a push is classified, what the screen
// and the missed-call notification say, and when the proximity sensor turns the screen off.
import type { CallOutcome, CallSnapshot } from '@pingdost/call-engine';
import type { ConversationRecord } from '@pingdost/message-engine';

import type { AudioRoute } from '../../modules/pingdost-calls/src';

export type CallKind = 'voice' | 'video';

/**
 * The call buttons of a chat. Group chats have none (REQ §19.5, §8.2): only direct chats with a
 * contact who is not blocked, and nothing while a call is live.
 */
export function callActionsFor(
  conversation: Pick<ConversationRecord, 'kind'> | undefined,
  options: { blocked: boolean },
): CallKind[] {
  if (conversation?.kind !== 'direct' || options.blocked) return [];
  return ['voice', 'video'];
}

/** The kind of a push (`{"t":"wake"}` or `{"t":"call"}`), however the platform hands it over. */
export function pushKind(data: unknown, depth = 0): 'wake' | 'call' {
  if (!data || typeof data !== 'object') return 'wake';
  const record = data as Record<string, unknown>;
  if (record.t === 'call') return 'call';
  if (typeof record.dataString === 'string') {
    try {
      if ((JSON.parse(record.dataString) as { t?: unknown }).t === 'call') return 'call';
    } catch {
      // Not JSON: a wake.
    }
  }
  // expo-notifications nests the FCM data under `data` on some paths.
  return depth < 2 ? pushKind(record.data, depth + 1) : 'wake';
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The line under the contact's name on the call screen. */
export function callStatus(call: CallSnapshot, now: number): string {
  switch (call.state) {
    case 'incoming':
      return call.video ? 'Incoming video call' : 'Incoming voice call';
    case 'outgoing':
      return 'Calling…';
    case 'ringing':
      return 'Ringing…';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'connected':
      return duration(now - (call.connectedAt ?? now));
    case 'ended':
      return call.outcome ? OUTCOME_TEXT[call.outcome] : 'Call ended';
    default:
      return '';
  }
}

export const OUTCOME_TEXT: Record<CallOutcome, string> = {
  completed: 'Call ended',
  rejected: 'Call declined',
  busy: 'Busy: in another call',
  no_answer: 'No answer',
  missed: 'Missed call',
  cancelled: 'Call cancelled',
  failed: 'Call failed',
  answered_elsewhere: 'Answered on another device',
  declined_elsewhere: 'Declined on another device',
};

export const ERROR_TEXT: Record<NonNullable<CallSnapshot['error']>, string> = {
  media_denied: 'PingDost may not use the microphone or camera. Allow it in the phone’s settings.',
  media_unavailable: 'The microphone or camera is not available.',
  no_devices: 'This contact has no device that can take calls.',
  unreachable: 'Could not reach this contact.',
  connection: 'The connection could not be made or was lost.',
  signaling: 'The call could not be set up. Check your connection.',
};

/** The missed-call notification: the name only when previews show senders. */
export function missedCallContent(
  call: Pick<CallSnapshot, 'video'>,
  name: string | undefined,
): { title: string; body: string } {
  const kind = call.video ? 'video call' : 'voice call';
  return name
    ? { title: 'Missed call', body: `Missed ${kind} from ${name}` }
    : { title: 'PingDost', body: `Missed ${kind}` };
}

/** Screen off at the ear: a voice call that plays on the earpiece. */
export function wantsProximity(call: CallSnapshot | null, route: AudioRoute | null): boolean {
  if (!call || call.video) return false;
  const live = ['outgoing', 'ringing', 'connecting', 'connected', 'reconnecting'].includes(
    call.state,
  );
  return live && route === 'earpiece';
}
