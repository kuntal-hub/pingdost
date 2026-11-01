import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import {
  CALL_SIGNAL_LIMITS,
  callSignalFromProto,
  callSignalToProto,
  type CallSignalData,
} from './calls';
import { CallSignal_Type, CallSignalSchema } from './gen/pingdost/v1/content_pb';
import { uuidv7 } from './ids';

const base = (): Pick<CallSignalData, 'callId' | 'callerDeviceId' | 'calleeDeviceId'> => ({
  callId: uuidv7(),
  callerDeviceId: uuidv7(),
  calleeDeviceId: uuidv7(),
});

describe('call signals as plain data', () => {
  it('round-trips every field', () => {
    const signals: CallSignalData[] = [
      { ...base(), type: 'offer', video: true, sdp: 'v=0\r\n', expiresAt: 1_700_000_000_000 },
      { ...base(), type: 'answer', sdp: 'v=0\r\n', muted: true, cameraOff: true },
      { ...base(), type: 'ice', candidates: ['{"candidate":"a"}', '{"candidate":"b"}'] },
      { ...base(), type: 'renegotiate', sdp: 'v=0\r\n', iceRestart: true },
      { ...base(), type: 'renegotiate' },
      { ...base(), type: 'hangup', reason: 'answered_elsewhere' },
      { ...base(), type: 'reject' },
      { ...base(), type: 'busy' },
      { ...base(), type: 'ringing' },
      { ...base(), type: 'media', muted: true },
    ];
    for (const signal of signals) {
      expect(callSignalFromProto(callSignalToProto(signal))).toEqual(signal);
    }
  });

  it('drops malformed or oversized signals', () => {
    const ok = callSignalToProto({ ...base(), type: 'ice', candidates: ['x'] });
    expect(callSignalFromProto({ ...ok, callerDeviceId: new Uint8Array(3) })).toBeUndefined();
    expect(callSignalFromProto({ ...ok, type: CallSignal_Type.UNSPECIFIED })).toBeUndefined();
    expect(
      callSignalFromProto({
        ...ok,
        iceCandidates: Array.from({ length: CALL_SIGNAL_LIMITS.candidates + 1 }, () => 'x'),
      }),
    ).toBeUndefined();
    expect(
      callSignalFromProto({
        ...ok,
        iceCandidates: ['x'.repeat(CALL_SIGNAL_LIMITS.candidateChars + 1)],
      }),
    ).toBeUndefined();
    // An offer or answer without SDP is useless.
    const offer = callSignalToProto({ ...base(), type: 'offer', sdp: 'v=0' });
    expect(callSignalFromProto({ ...offer, sdp: '' })).toBeUndefined();
    // Phase 4's vector had no device IDs: such a signal is not accepted.
    expect(
      callSignalFromProto(
        create(CallSignalSchema, { callId: new Uint8Array(16), type: 1, sdp: 'x' }),
      ),
    ).toBeUndefined();
  });
});
