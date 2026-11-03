import { describe, expect, it } from 'vitest';

import type { CallSnapshot } from '@pingdost/call-engine';

import { CallKitBridge, endReasonFor, type CallKitNative } from './callkit';

const CALL_ID = '019a4f2e-1c3b-7d4e-9f00-112233445566';
const PUSH = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function snapshot(fields: Partial<CallSnapshot> = {}): CallSnapshot {
  return {
    callId: CALL_ID,
    peerUserId: 'u',
    peerDeviceId: null,
    direction: 'in',
    video: false,
    state: 'incoming',
    outcome: null,
    error: null,
    startedAt: 0,
    answeredAt: null,
    connectedAt: null,
    endedAt: null,
    muted: false,
    cameraOff: false,
    remoteMuted: false,
    remoteCameraOff: false,
    relayOnly: false,
    ...fields,
  };
}

function setup(pending: string[] = []) {
  const calls: string[] = [];
  const timers: (() => void)[] = [];
  const native: CallKitNative = {
    reportIncoming: (uuid, name, video) => calls.push(`reportIncoming ${uuid} ${name} ${video}`),
    updateCall: (uuid, name, video) => calls.push(`updateCall ${uuid} ${name} ${video}`),
    startOutgoing: (uuid, name, video) => calls.push(`startOutgoing ${uuid} ${name} ${video}`),
    reportConnected: (uuid) => calls.push(`reportConnected ${uuid}`),
    endCall: (uuid, reason) => calls.push(`endCall ${uuid} ${reason}`),
    bindPushCall: (uuid) => calls.push(`bindPushCall ${uuid}`),
    pendingPushCalls: () => pending,
  };
  const bridge = new CallKitBridge(
    native,
    {
      accept: (callId) => calls.push(`accept ${callId}`),
      reject: () => calls.push('reject'),
      hangup: () => calls.push('hangup'),
      setMuted: (muted) => calls.push(`setMuted ${muted}`),
      audio: (active) => calls.push(`audio ${active}`),
    },
    {
      randomUuid: () => 'RANDOM-UUID',
      setTimer: (run) => timers.push(run),
      clearTimer: () => undefined,
    },
  );
  return { bridge, calls, timers };
}

describe('CallKit bridge: incoming calls', () => {
  it('reports an invite that came over the socket as a new CallKit call', () => {
    const { bridge, calls } = setup();
    bridge.onCall(snapshot(), 'PingDost');
    bridge.onCall(snapshot(), 'Asha');
    bridge.onCall(snapshot({ state: 'connecting' }), 'Asha');
    bridge.onCall(snapshot({ state: 'connected', connectedAt: 1 }), 'Asha');
    bridge.onCall(snapshot({ state: 'ended', outcome: 'completed' }), 'Asha');
    expect(calls).toEqual([
      `reportIncoming ${CALL_ID} PingDost false`,
      `updateCall ${CALL_ID} Asha false`,
      `reportConnected ${CALL_ID}`,
      `endCall ${CALL_ID} remote`,
    ]);
  });

  it('binds the call a VoIP push reported to the invite, then names it', () => {
    const { bridge, calls } = setup();
    // Swift prints UUIDs in upper case.
    bridge.onEvent({ type: 'push', uuid: PUSH.toUpperCase() });
    bridge.onCall(snapshot({ video: true }), 'Asha');
    expect(calls).toEqual([`bindPushCall ${PUSH}`, `updateCall ${PUSH} Asha true`]);
    expect(bridge.uuidOf(CALL_ID)).toBe(PUSH);
  });

  it('picks up push calls reported before the app started', () => {
    const { bridge, calls } = setup([PUSH]);
    bridge.onCall(snapshot(), 'Asha');
    expect(calls).toEqual([`bindPushCall ${PUSH}`, `updateCall ${PUSH} Asha false`]);
  });

  it('ends a push call whose invite never came', () => {
    const { bridge, calls, timers } = setup();
    bridge.onEvent({ type: 'push', uuid: PUSH });
    timers[0]?.();
    expect(calls).toEqual([`endCall ${PUSH} unanswered`]);
    // A late invite is then a new call.
    bridge.onCall(snapshot(), 'Asha');
    expect(calls.at(-1)).toBe(`reportIncoming ${CALL_ID} Asha false`);
  });

  it('answers once the invite arrives when the user answered on the lock screen first', () => {
    const { bridge, calls } = setup();
    bridge.onEvent({ type: 'push', uuid: PUSH });
    bridge.onEvent({ type: 'answer', uuid: PUSH });
    expect(calls).toEqual([]);
    bridge.onCall(snapshot(), 'Asha');
    expect(calls).toEqual([
      `bindPushCall ${PUSH}`,
      `updateCall ${PUSH} Asha false`,
      `accept ${CALL_ID}`,
    ]);
  });

  it('rejects without ringing again when declined before the invite arrived', () => {
    const { bridge, calls, timers } = setup();
    bridge.onEvent({ type: 'push', uuid: PUSH });
    bridge.onEvent({ type: 'end', uuid: PUSH });
    bridge.onCall(snapshot(), 'Asha');
    bridge.onCall(snapshot({ state: 'ended', outcome: 'rejected' }), 'Asha');
    timers[0]?.();
    expect(calls).toEqual(['reject']);
  });

  it('maps the system screen’s answer, decline, mute and audio to the manager', () => {
    const { bridge, calls } = setup();
    bridge.onCall(snapshot(), 'Asha');
    bridge.onEvent({ type: 'answer', uuid: CALL_ID });
    bridge.onCall(snapshot({ state: 'connected', connectedAt: 1 }), 'Asha');
    bridge.onEvent({ type: 'mute', uuid: CALL_ID, muted: true });
    bridge.onEvent({ type: 'audio', active: true });
    bridge.onEvent({ type: 'end', uuid: CALL_ID });
    bridge.onCall(snapshot({ state: 'ended', outcome: 'completed' }), 'Asha');
    expect(calls).toEqual([
      `reportIncoming ${CALL_ID} Asha false`,
      `accept ${CALL_ID}`,
      `reportConnected ${CALL_ID}`,
      'setMuted true',
      'audio true',
      'hangup',
    ]);
  });

  it('declines a ringing call ended on the system screen', () => {
    const { bridge, calls } = setup();
    bridge.onCall(snapshot(), 'Asha');
    bridge.onEvent({ type: 'end', uuid: CALL_ID });
    expect(calls.at(-1)).toBe('reject');
  });

  it('ends a push call that arrives during a live call at once', () => {
    const { bridge, calls } = setup();
    bridge.onCall(snapshot(), 'Asha');
    bridge.onEvent({ type: 'push', uuid: PUSH });
    expect(calls.at(-1)).toBe(`endCall ${PUSH} remote`);
    bridge.onCall(snapshot({ state: 'connected', connectedAt: 1 }), 'Asha');
    bridge.onEvent({ type: 'push', uuid: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(calls.at(-1)).toBe('endCall cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee remote');
  });

  it('waits for an invite again once the last call ended', () => {
    const { bridge, calls } = setup();
    bridge.onCall(snapshot(), 'Asha');
    bridge.onCall(snapshot({ state: 'ended', outcome: 'missed' }), 'Asha');
    bridge.onEvent({ type: 'push', uuid: PUSH });
    bridge.onCall(snapshot({ callId: '019a4f2e-1c3b-7d4e-9f00-998877665544' }), 'Ravi');
    expect(calls.slice(-2)).toEqual([`bindPushCall ${PUSH}`, `updateCall ${PUSH} Ravi false`]);
  });

  it('gives a peer-chosen call ID that is not a UUID a random one', () => {
    const { bridge, calls } = setup();
    bridge.onCall(snapshot({ callId: 'not-a-uuid' }), 'Asha');
    expect(calls).toEqual(['reportIncoming random-uuid Asha false']);
  });
});

describe('CallKit bridge: outgoing calls and ends', () => {
  it('reports outgoing calls and their connection', () => {
    const { bridge, calls } = setup();
    const out = snapshot({ direction: 'out', state: 'outgoing' });
    bridge.onCall(out, 'Asha');
    bridge.onCall({ ...out, state: 'ringing' }, 'Asha');
    bridge.onCall({ ...out, state: 'connected', connectedAt: 1 }, 'Asha');
    bridge.endedLocally(CALL_ID);
    bridge.onCall({ ...out, state: 'ended', outcome: 'completed' }, 'Asha');
    expect(calls).toEqual([
      `startOutgoing ${CALL_ID} Asha false`,
      `reportConnected ${CALL_ID}`,
      `endCall ${CALL_ID} local`,
    ]);
  });

  it('tells CallKit why a call ended', () => {
    expect(endReasonFor('completed')).toBe('remote');
    expect(endReasonFor('cancelled')).toBe('remote');
    expect(endReasonFor('missed')).toBe('unanswered');
    expect(endReasonFor('no_answer')).toBe('unanswered');
    expect(endReasonFor('answered_elsewhere')).toBe('answeredElsewhere');
    expect(endReasonFor('declined_elsewhere')).toBe('declinedElsewhere');
    expect(endReasonFor('failed')).toBe('failed');
    expect(endReasonFor(null)).toBe('failed');
  });
});
