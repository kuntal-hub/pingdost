import { describe, expect, it } from 'vitest';

import type { CallSnapshot } from '@pingdost/call-engine';

import {
  callActionsFor,
  callStatus,
  missedCallContent,
  pushKind,
  routeAfterSwitch,
  screenShareChoices,
  shouldPauseCamera,
  wantsPip,
  wantsProximity,
} from './logic';

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
    videoRequest: null,
    videoDeclinedAt: null,
    screenSharing: false,
    remoteScreenSharing: false,
    canVideo: true,
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
    // A shared screen is something to look at (ADR 0037).
    expect(wantsProximity(snapshot({ remoteScreenSharing: true }), 'earpiece')).toBe(false);
    expect(wantsProximity(snapshot({ screenSharing: true }), 'earpiece')).toBe(false);
  });
});

describe('in-call changes (ADR 0037)', () => {
  it('offers picture-in-picture for video and for the other side’s screen, not for voice', () => {
    expect(wantsPip(snapshot({ video: true }))).toBe(true);
    expect(wantsPip(snapshot({ remoteScreenSharing: true }))).toBe(true);
    expect(wantsPip(snapshot())).toBe(false);
    expect(wantsPip(snapshot({ video: true, remoteCameraOff: true }))).toBe(false);
    expect(wantsPip(snapshot({ video: true, state: 'incoming' }))).toBe(false);
    expect(wantsPip(snapshot({ video: true, state: 'ended' }))).toBe(false);
    expect(wantsPip(null)).toBe(false);
  });

  it('pauses the camera only while nobody can see the app', () => {
    const video = snapshot({ video: true });
    expect(shouldPauseCamera(video, false, false)).toBe(true);
    expect(shouldPauseCamera(video, true, false)).toBe(false);
    expect(shouldPauseCamera(video, false, true)).toBe(false);
    expect(shouldPauseCamera(snapshot(), false, false)).toBe(false);
    // Already off by the user: nothing to pause (and nothing to turn back on later).
    expect(shouldPauseCamera(snapshot({ video: true, cameraOff: true }), false, false)).toBe(false);
  });

  it('moves the sound to the speaker for video and back for voice, leaving headsets alone', () => {
    expect(
      routeAfterSwitch(true, { available: ['earpiece', 'speaker'], current: 'earpiece' }),
    ).toBe('speaker');
    expect(
      routeAfterSwitch(false, { available: ['earpiece', 'speaker'], current: 'speaker' }),
    ).toBe('earpiece');
    expect(routeAfterSwitch(true, { available: ['speaker', 'headset'], current: 'headset' })).toBe(
      null,
    );
    expect(routeAfterSwitch(false, { available: ['speaker'], current: 'speaker' })).toBe(null);
    expect(routeAfterSwitch(true, null)).toBe(null);
  });

  it('offers one app only from Android 14', () => {
    expect(screenShareChoices(36)).toEqual(['app', 'screen']);
    expect(screenShareChoices(34)).toEqual(['app', 'screen']);
    expect(screenShareChoices(33)).toEqual(['screen']);
  });
});
