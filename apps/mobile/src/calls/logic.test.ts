import { describe, expect, it } from 'vitest';

import type { CallSnapshot } from '@pingdost/call-engine';

import { callActionsFor, callStatus, missedCallContent, pushKind, wantsProximity } from './logic';

function snapshot(fields: Partial<CallSnapshot> = {}): CallSnapshot {
  return {
    callId: 'c',
    peerUserId: 'u',
    peerDeviceId: null,
    direction: 'out',
    video: false,
    state: 'connected',
    outcome: null,
    error: null,
    startedAt: 0,
    answeredAt: 0,
    connectedAt: 1_000,
    endedAt: null,
    muted: false,
    cameraOff: false,
    remoteMuted: false,
    remoteCameraOff: false,
    relayOnly: false,
    ...fields,
  };
}

describe('call actions', () => {
  it('offers voice and video calls in direct chats only; groups have none (REQ §19.5)', () => {
    expect(callActionsFor({ kind: 'direct' }, { blocked: false })).toEqual(['voice', 'video']);
    expect(callActionsFor({ kind: 'group' }, { blocked: false })).toEqual([]);
    expect(callActionsFor({ kind: 'direct' }, { blocked: true })).toEqual([]);
    expect(callActionsFor(undefined, { blocked: false })).toEqual([]);
  });
});

describe('push kind', () => {
  it('finds `call` however the payload arrives, and treats anything else as a wake', () => {
    expect(pushKind({ t: 'call' })).toBe('call');
    expect(pushKind({ dataString: '{"t":"call"}' })).toBe('call');
    expect(pushKind({ data: { t: 'call' } })).toBe('call');
    expect(pushKind({ notification: null, data: { dataString: '{"t":"call"}' } })).toBe('call');
    expect(pushKind({ t: 'wake' })).toBe('wake');
    expect(pushKind({ dataString: 'not json' })).toBe('wake');
    expect(pushKind(undefined)).toBe('wake');
  });
});

describe('call screen wording', () => {
  it('describes each state', () => {
    expect(callStatus(snapshot({ state: 'incoming', video: true }), 0)).toBe('Incoming video call');
    expect(callStatus(snapshot({ state: 'ringing' }), 0)).toBe('Ringing…');
    expect(callStatus(snapshot({ state: 'connected', connectedAt: 1_000 }), 66_000)).toBe('1:05');
    expect(callStatus(snapshot({ state: 'ended', outcome: 'busy' }), 0)).toBe(
      'Busy: in another call',
    );
  });

  it('names the caller in a missed-call notice only when previews show senders', () => {
    expect(missedCallContent({ video: false }, 'Asha')).toEqual({
      title: 'Missed call',
      body: 'Missed voice call from Asha',
    });
    expect(missedCallContent({ video: true }, undefined)).toEqual({
      title: 'PingDost',
      body: 'Missed video call',
    });
  });

  it('turns the screen off at the ear only for live voice calls on the earpiece', () => {
    expect(wantsProximity(snapshot(), 'earpiece')).toBe(true);
    expect(wantsProximity(snapshot(), 'speaker')).toBe(false);
    expect(wantsProximity(snapshot({ video: true }), 'earpiece')).toBe(false);
    expect(wantsProximity(snapshot({ state: 'incoming' }), 'earpiece')).toBe(false);
    expect(wantsProximity(null, 'earpiece')).toBe(false);
  });
});
