/**
 * CallManager scenarios over the fake signaling hub and fake WebRTC network (ADR 0028): calls
 * end to end, several callee devices, reject, busy, timeouts, offline devices, glare, ICE
 * restarts, failures, media state and device binding. Timings are scaled down.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@pingdost/protocol';

import { CallError, CallManager, type CallSettings, type CallSnapshot } from './manager';
import { CallMediaError, FakeRtcNetwork, FakeSignalingHub, type FakePlatform } from './testing';

const FAST: CallSettings = {
  ringTimeoutMs: 600,
  offerResendMs: 40,
  connectTimeoutMs: 500,
  reconnectTimeoutMs: 500,
  restartDelayMs: 30,
  candidateBatchMs: 5,
  signalRetryMs: 20,
  finalSignalRetryWindowMs: 200,
};

interface Device {
  userId: string;
  deviceId: string;
  manager: CallManager;
  platform: FakePlatform;
  ended: CallSnapshot[];
}

const managers: CallManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
});

function device(
  hub: FakeSignalingHub,
  network: FakeRtcNetwork,
  userId: string,
  options: Partial<ConstructorParameters<typeof CallManager>[0]> = {},
): Device {
  const deviceId = uuidv7();
  const platform = network.platform(deviceId.slice(-6));
  const ended: CallSnapshot[] = [];
  const manager = new CallManager({
    self: { userId, deviceId },
    signaling: hub.device(userId, deviceId),
    platform,
    settings: FAST,
    onEnded: (call) => ended.push(call),
    ...options,
  });
  managers.push(manager);
  return { userId, deviceId, manager, platform, ended };
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const state = (d: Device) => d.manager.call?.state;

function setup(): { hub: FakeSignalingHub; network: FakeRtcNetwork; alice: Device; bob: Device } {
  const hub = new FakeSignalingHub();
  const network = new FakeRtcNetwork();
  return { hub, network, alice: device(hub, network, 'alice'), bob: device(hub, network, 'bob') };
}

async function connect(alice: Device, bob: Device, video = false): Promise<void> {
  await alice.manager.dial(bob.userId, { video });
  await until(() => state(bob) === 'incoming' && state(alice) === 'ringing');
  await bob.manager.accept();
  await until(() => state(alice) === 'connected' && state(bob) === 'connected');
}

describe('CallManager', () => {
  it('rings, connects and ends a call as completed on both sides', async () => {
    const { hub, alice, bob } = setup();
    await alice.manager.dial(bob.userId, { video: true });
    expect(state(alice)).toMatch(/outgoing|ringing/);
    await until(() => state(bob) === 'incoming');
    expect(bob.manager.call).toMatchObject({
      direction: 'in',
      video: true,
      peerUserId: 'alice',
      peerDeviceId: alice.deviceId,
    });
    await until(() => state(alice) === 'ringing');
    await bob.manager.accept();
    await until(() => state(alice) === 'connected' && state(bob) === 'connected');
    const call = alice.manager.call!;
    expect(call.peerDeviceId).toBe(bob.deviceId);
    expect(call.answeredAt).not.toBeNull();
    expect(call.connectedAt! - call.answeredAt!).toBeGreaterThanOrEqual(0);
    // Both sides opened media with the server's ICE servers.
    expect(alice.platform.peers[0]!.options.iceServers).toHaveLength(1);
    expect(bob.platform.peers[0]!.options.video).toBe(true);

    await alice.manager.hangup();
    await until(() => bob.ended.length === 1);
    expect(alice.ended[0]).toMatchObject({ outcome: 'completed', state: 'ended' });
    expect(bob.ended[0]).toMatchObject({ outcome: 'completed' });
    expect(alice.platform.peers[0]!.closed && bob.platform.peers[0]!.closed).toBe(true);
    // Candidates were batched: far fewer ICE signals than candidates.
    expect(hub.count('ice')).toBeLessThanOrEqual(4);
  });

  it('rings every callee device; the first answer takes the call', async () => {
    const { hub, network, alice, bob } = setup();
    const bobWeb = device(hub, network, 'bob');
    await alice.manager.dial('bob', { video: false });
    await until(() => state(bob) === 'incoming' && state(bobWeb) === 'incoming');
    await bobWeb.manager.accept();
    await until(() => state(alice) === 'connected' && state(bobWeb) === 'connected');
    await until(() => bob.ended.length === 1);
    expect(bob.ended[0]!.outcome).toBe('answered_elsewhere');
    expect(alice.manager.call!.peerDeviceId).toBe(bobWeb.deviceId);
    // The phone never opened its microphone.
    expect(bob.platform.peers).toHaveLength(0);
  });

  it('a reject from one device ends the call; the other devices stop ringing', async () => {
    const { hub, network, alice, bob } = setup();
    const bobWeb = device(hub, network, 'bob');
    await alice.manager.dial('bob', { video: false });
    await until(() => state(bob) === 'incoming' && state(bobWeb) === 'incoming');
    await bob.manager.reject();
    await until(() => alice.ended.length === 1 && bobWeb.ended.length === 1);
    expect(alice.ended[0]!.outcome).toBe('rejected');
    expect(bob.ended[0]!.outcome).toBe('rejected');
    expect(bobWeb.ended[0]!.outcome).toBe('declined_elsewhere');
  });

  it('answers busy while in another call', async () => {
    const { hub, network, alice, bob } = setup();
    const carol = device(hub, network, 'carol');
    await connect(alice, bob);
    await carol.manager.dial('bob', { video: false });
    await until(() => carol.ended.length === 1);
    expect(carol.ended[0]!.outcome).toBe('busy');
    expect(state(bob)).toBe('connected');
    await expect(bob.manager.dial('carol', { video: false })).rejects.toBeInstanceOf(CallError);
  });

  it('follows the incoming policy (another tab answers busy, a GSM call is busy)', async () => {
    const hub = new FakeSignalingHub();
    const network = new FakeRtcNetwork();
    const alice = device(hub, network, 'alice');
    const bob = device(hub, network, 'bob', { incomingPolicy: () => 'ignore' });
    device(hub, network, 'carol', { incomingPolicy: () => 'busy' });
    await alice.manager.dial('bob', { video: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bob.manager.call).toBeNull();
    await alice.manager.hangup();
    await alice.manager.dial('carol', { video: false });
    await until(() => alice.ended.length === 2);
    expect(alice.ended[1]!.outcome).toBe('busy');
  });

  it('ends unanswered calls: no answer for the caller, missed for the callee', async () => {
    const { alice, bob } = setup();
    await alice.manager.dial('bob', { video: false });
    await until(() => alice.ended.length === 1 && bob.ended.length === 1, 2_000);
    expect(alice.ended[0]!.outcome).toBe('no_answer');
    expect(bob.ended[0]!.outcome).toBe('missed');
  });

  it('a call cancelled by the caller is missed by the callee', async () => {
    const { alice, bob } = setup();
    await alice.manager.dial('bob', { video: false });
    await until(() => state(bob) === 'incoming');
    await alice.manager.hangup();
    await until(() => bob.ended.length === 1);
    expect(alice.ended[0]!.outcome).toBe('cancelled');
    expect(bob.ended[0]!.outcome).toBe('missed');
  });

  it('re-sends the invite to an offline device until it comes online', async () => {
    const { hub, alice, bob } = setup();
    hub.setOnline(bob.deviceId, false);
    await alice.manager.dial('bob', { video: false });
    await until(() => hub.count('offer', bob.deviceId) >= 3);
    expect(state(alice)).toBe('outgoing');
    hub.setOnline(bob.deviceId, true); // woken by the call push
    await until(() => state(bob) === 'incoming');
    await bob.manager.accept();
    await until(() => state(alice) === 'connected' && state(bob) === 'connected');
  });

  it('fails an outgoing call with no devices to ring', async () => {
    const { alice } = setup();
    await alice.manager.dial('nobody', { video: false });
    expect(alice.ended[0]).toMatchObject({ outcome: 'failed', error: 'no_devices' });
  });

  it('resolves glare: both keep the call with the lower ID', async () => {
    const { alice, bob } = setup();
    const [a, b] = await Promise.all([
      alice.manager.dial('bob', { video: false }),
      bob.manager.dial('alice', { video: true }),
    ]);
    const winner = a.callId < b.callId ? a.callId : b.callId;
    await until(() => state(alice) === 'connected' && state(bob) === 'connected');
    expect(alice.manager.call!.callId).toBe(winner);
    expect(bob.manager.call!.callId).toBe(winner);
    // Both sides follow the surviving call's video setting.
    const survivor = a.callId < b.callId ? a : b;
    expect(alice.manager.call!.video).toBe(survivor.video);
    expect(bob.manager.call!.video).toBe(survivor.video);
    // The other call left no history entry behind (it was replaced, not ended).
    expect([...alice.ended, ...bob.ended]).toEqual([]);
  });

  it('restarts ICE after the connection drops, and on a network change', async () => {
    const { network, alice, bob } = setup();
    await connect(alice, bob, true);
    network.drop();
    await until(() => state(alice) === 'reconnecting' && state(bob) === 'reconnecting');
    await until(() => state(alice) === 'connected' && state(bob) === 'connected');
    expect(alice.platform.peers[0]!.generation).toBe(2);
    expect(bob.platform.peers[0]!.generation).toBe(2);

    // The callee's network changed and the connection did drop: it asks the caller for a
    // restart, and the call recovers.
    bob.manager.networkChanged();
    network.drop();
    await until(() => state(bob) === 'reconnecting');
    await until(
      () =>
        state(alice) === 'connected' &&
        state(bob) === 'connected' &&
        alice.platform.peers[0]!.generation >= 3,
    );
    expect(bob.platform.peers[0]!.generation).toBe(alice.platform.peers[0]!.generation);
    expect(alice.ended).toEqual([]);
  });

  it('keeps the call when WebRTC rides out a network change', async () => {
    // Found on two phones (Wi-Fi → mobile data): the restart went through and the connection
    // never left "connected", but the call was marked "reconnecting" on the network change and
    // hung up when the reconnect timer ran out.
    const { alice, bob } = setup();
    await connect(alice, bob);
    bob.manager.networkChanged();
    expect(state(bob)).toBe('connected');
    await until(
      () => alice.platform.peers[0]!.generation === 2 && bob.platform.peers[0]!.generation === 2,
    );
    await new Promise((resolve) => setTimeout(resolve, FAST.reconnectTimeoutMs + 200));
    expect(state(alice)).toBe('connected');
    expect(state(bob)).toBe('connected');
    expect([...alice.ended, ...bob.ended]).toEqual([]);
  });

  it('fails a call that cannot reconnect, or never connects', async () => {
    const { network, alice, bob } = setup();
    await connect(alice, bob);
    network.blocked = true;
    network.drop();
    await until(() => alice.ended.length === 1 && bob.ended.length === 1, 2_000);
    expect(alice.ended[0]).toMatchObject({ outcome: 'failed', error: 'connection' });
    expect(bob.ended[0]!.outcome).toBe('failed');

    // Never connects: the connect timeout ends it.
    await alice.manager.dial('bob', { video: false });
    await until(() => state(bob) === 'incoming');
    await bob.manager.accept();
    await until(() => alice.ended.length === 2 && bob.ended.length === 2, 2_000);
    expect([alice.ended[1]!.outcome, bob.ended[1]!.outcome]).toEqual(['failed', 'failed']);
    // The side that timed out first says why; the other was told "failed".
    expect([alice.ended[1]!.error, bob.ended[1]!.error]).toContain('connection');
  });

  it('fails cleanly when the microphone or camera is denied', async () => {
    const { alice, bob } = setup();
    bob.platform.mediaError = new CallMediaError('denied');
    await alice.manager.dial('bob', { video: true });
    await until(() => state(bob) === 'incoming');
    await bob.manager.accept();
    expect(bob.ended[0]).toMatchObject({ outcome: 'failed', error: 'media_denied' });
    // Bob's only device dropped out: Alice's call ends too.
    await until(() => alice.ended.length === 1);
    expect(alice.ended[0]!.outcome).toBe('failed');

    alice.platform.mediaError = new CallMediaError('unavailable');
    await alice.manager.dial('bob', { video: false });
    expect(alice.ended[1]).toMatchObject({ outcome: 'failed', error: 'media_unavailable' });
  });

  it('shares mute and camera state with the other side', async () => {
    const { alice, bob } = setup();
    await connect(alice, bob, true);
    alice.manager.setMuted(true);
    alice.manager.setCameraOff(true);
    expect(alice.platform.peers[0]!.muted).toBe(true);
    expect(alice.platform.peers[0]!.cameraOff).toBe(true);
    await until(() => bob.manager.call!.remoteMuted && bob.manager.call!.remoteCameraOff);
    alice.manager.setMuted(false);
    await until(() => !bob.manager.call!.remoteMuted);
  });

  it('passes "Force relay" to the platform; a relay-only network connects only such peers', async () => {
    const hub = new FakeSignalingHub();
    const network = new FakeRtcNetwork();
    network.requireRelay = true;
    const alice = device(hub, network, 'alice', { relayOnly: () => true });
    const bob = device(hub, network, 'bob', { relayOnly: () => true });
    await connect(alice, bob);
    expect(alice.platform.peers[0]!.options.relayOnly).toBe(true);
    expect(alice.manager.call!.relayOnly).toBe(true);
  });

  it('ignores signals from other devices, for other calls, and lapsed invites', async () => {
    const { hub, alice, bob } = setup();
    await alice.manager.dial('bob', { video: false });
    await until(() => state(bob) === 'incoming');
    const call = bob.manager.call!;
    // A hang-up that names the call but comes from a device that is not the caller's.
    hub.inject(bob.deviceId, {
      fromUserId: 'alice',
      fromDeviceId: uuidv7(),
      signal: {
        callId: call.callId,
        type: 'hangup',
        callerDeviceId: alice.deviceId,
        calleeDeviceId: bob.deviceId,
      },
    });
    // An invite whose time is up.
    hub.inject(bob.deviceId, {
      fromUserId: 'mallory',
      fromDeviceId: 'x',
      signal: {
        callId: uuidv7(),
        type: 'offer',
        sdp: 'fake x 1',
        callerDeviceId: 'x',
        calleeDeviceId: bob.deviceId,
        expiresAt: Date.now() - 1,
      },
    });
    await bob.manager.idle();
    expect(bob.manager.call).toMatchObject({ callId: call.callId, state: 'incoming' });
    await bob.manager.accept();
    await until(() => state(alice) === 'connected');
  });

  it('stops ringing in this tab when another tab takes the call', async () => {
    const { alice, bob } = setup();
    await alice.manager.dial('bob', { video: false });
    await until(() => state(bob) === 'incoming');
    bob.manager.dismiss(bob.manager.call!.callId);
    expect(bob.ended[0]!.outcome).toBe('answered_elsewhere');
    // A copy of the same invite does not ring again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bob.manager.busy).toBe(false);
  });
});
