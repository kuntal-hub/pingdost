/**
 * Call signaling as plain data (ADR 0028): what the call engine and the apps pass around, and
 * what crosses between browser tabs (structured clone). The message engine turns it into the
 * E2EE `CallSignal` Content and back.
 */
import { create } from '@bufbuild/protobuf';

import {
  CallSignal_ModeChange,
  CallSignal_Reason,
  CallSignal_Type,
  CallSignalSchema,
  type CallSignal,
} from './gen/pingdost/v1/content_pb';
import { bytesToUuid, uuidToBytes } from './ids';

export type CallSignalType =
  | 'offer'
  | 'answer'
  | 'ice'
  | 'hangup'
  | 'reject'
  | 'busy'
  | 'renegotiate'
  | 'ringing'
  | 'media'
  | 'mode';

export type CallHangupReason =
  'normal' | 'answered_elsewhere' | 'no_answer' | 'failed' | 'replaced' | 'declined_elsewhere';

/**
 * `mode` signals (ADR 0037): voice → video is a request the other side accepts or declines
 * (or the asker withdraws); video → voice applies at once.
 */
export type CallModeChange = 'video_request' | 'video_accept' | 'video_decline' | 'voice';

export interface CallSignalData {
  /** UUIDv7. */
  callId: string;
  type: CallSignalType;
  callerDeviceId: string;
  calleeDeviceId: string;
  /** The call has video (offer and answer). */
  video?: boolean;
  /** offer, answer, renegotiate. */
  sdp?: string;
  /** ice: RTCIceCandidateInit JSON strings. */
  candidates?: string[];
  /** offer: epoch ms after which the invite is ignored. */
  expiresAt?: number;
  /** renegotiate. */
  iceRestart?: boolean;
  /** hangup. */
  reason?: CallHangupReason;
  /** media (and offer/answer). */
  muted?: boolean;
  cameraOff?: boolean;
  /** media: the sender's video is its screen or one app. */
  screenSharing?: boolean;
  /** mode. */
  modeChange?: CallModeChange;
  /** mode: the asker's random request number, repeated by the answer. */
  modeRequestId?: number;
}

/**
 * How a call ended, as each side records it locally (REQ §12.2). `missed`: an incoming call
 * nobody answered here; `cancelled`: the caller hung up before an answer.
 */
export type CallOutcome =
  | 'completed'
  | 'rejected'
  | 'busy'
  | 'no_answer'
  | 'missed'
  | 'cancelled'
  | 'failed'
  | 'answered_elsewhere'
  | 'declined_elsewhere';

/** A signal as received: the sender is authenticated by its Olm session. */
export interface IncomingCallSignal {
  fromUserId: string;
  fromDeviceId: string;
  signal: CallSignalData;
}

const TYPES: Record<CallSignalType, CallSignal_Type> = {
  offer: CallSignal_Type.OFFER,
  answer: CallSignal_Type.ANSWER,
  ice: CallSignal_Type.ICE_CANDIDATE,
  hangup: CallSignal_Type.HANGUP,
  reject: CallSignal_Type.REJECT,
  busy: CallSignal_Type.BUSY,
  renegotiate: CallSignal_Type.RENEGOTIATE,
  ringing: CallSignal_Type.RINGING,
  media: CallSignal_Type.MEDIA_STATE,
  mode: CallSignal_Type.MODE,
};

const MODE_CHANGES: Record<CallModeChange, CallSignal_ModeChange> = {
  video_request: CallSignal_ModeChange.VIDEO_REQUEST,
  video_accept: CallSignal_ModeChange.VIDEO_ACCEPT,
  video_decline: CallSignal_ModeChange.VIDEO_DECLINE,
  voice: CallSignal_ModeChange.VOICE,
};

const REASONS: Record<CallHangupReason, CallSignal_Reason> = {
  normal: CallSignal_Reason.NORMAL,
  answered_elsewhere: CallSignal_Reason.ANSWERED_ELSEWHERE,
  no_answer: CallSignal_Reason.NO_ANSWER,
  failed: CallSignal_Reason.FAILED,
  replaced: CallSignal_Reason.REPLACED,
  declined_elsewhere: CallSignal_Reason.DECLINED_ELSEWHERE,
};

function invert<K extends string, V extends number>(map: Record<K, V>): Map<V, K> {
  return new Map(Object.entries(map).map(([k, v]) => [v as V, k as K]));
}

const TYPE_NAMES = invert(TYPES);
const REASON_NAMES = invert(REASONS);
const MODE_CHANGE_NAMES = invert(MODE_CHANGES);

/** Limits on what a peer may make this device parse and keep (defence in depth). */
export const CALL_SIGNAL_LIMITS = {
  sdpChars: 32_768,
  candidates: 64,
  candidateChars: 1_024,
} as const;

export function callSignalToProto(data: CallSignalData): CallSignal {
  return create(CallSignalSchema, {
    callId: uuidToBytes(data.callId),
    type: TYPES[data.type],
    video: data.video ?? false,
    sdp: data.sdp ?? '',
    callerDeviceId: uuidToBytes(data.callerDeviceId),
    calleeDeviceId: uuidToBytes(data.calleeDeviceId),
    expiresAtMs: BigInt(data.expiresAt ?? 0),
    iceCandidates: data.candidates ?? [],
    iceRestart: data.iceRestart ?? false,
    reason: data.reason ? REASONS[data.reason] : CallSignal_Reason.UNSPECIFIED,
    muted: data.muted ?? false,
    cameraOff: data.cameraOff ?? false,
    modeChange: data.modeChange ? MODE_CHANGES[data.modeChange] : CallSignal_ModeChange.UNSPECIFIED,
    modeRequestId: data.modeRequestId ?? 0,
    screenSharing: data.screenSharing ?? false,
  });
}

/** The signal as plain data, or undefined when it is malformed or over the limits. */
export function callSignalFromProto(signal: CallSignal): CallSignalData | undefined {
  const type = TYPE_NAMES.get(signal.type);
  if (!type) return undefined;
  let callId: string, callerDeviceId: string, calleeDeviceId: string;
  try {
    callId = bytesToUuid(signal.callId);
    callerDeviceId = bytesToUuid(signal.callerDeviceId);
    calleeDeviceId = bytesToUuid(signal.calleeDeviceId);
  } catch {
    return undefined;
  }
  if (signal.sdp.length > CALL_SIGNAL_LIMITS.sdpChars) return undefined;
  if (signal.iceCandidates.length > CALL_SIGNAL_LIMITS.candidates) return undefined;
  if (signal.iceCandidates.some((c) => c.length > CALL_SIGNAL_LIMITS.candidateChars)) {
    return undefined;
  }
  if ((type === 'offer' || type === 'answer') && signal.sdp === '') return undefined;
  const modeChange = MODE_CHANGE_NAMES.get(signal.modeChange);
  if (type === 'mode' && !modeChange) return undefined;
  const data: CallSignalData = { callId, type, callerDeviceId, calleeDeviceId };
  if (signal.video) data.video = true;
  if (signal.sdp !== '') data.sdp = signal.sdp;
  if (signal.iceCandidates.length > 0) data.candidates = [...signal.iceCandidates];
  if (signal.expiresAtMs > 0n) data.expiresAt = Number(signal.expiresAtMs);
  if (signal.iceRestart) data.iceRestart = true;
  const reason = REASON_NAMES.get(signal.reason);
  if (reason) data.reason = reason;
  if (signal.muted) data.muted = true;
  if (signal.cameraOff) data.cameraOff = true;
  if (signal.screenSharing) data.screenSharing = true;
  if (modeChange) data.modeChange = modeChange;
  if (signal.modeRequestId > 0) data.modeRequestId = signal.modeRequestId;
  return data;
}
