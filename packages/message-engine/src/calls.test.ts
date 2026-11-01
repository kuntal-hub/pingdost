/**
 * Call signaling over the ephemeral channel (ADR 0028) between two users' engines on the fake
 * server, with real vodozemac: ringing every callee device, the RING flag on invites, device
 * binding, blocks, offline devices and the local call history.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import {
  PacketFlag,
  uuidv7,
  type CallSignalData,
  type IncomingCallSignal,
  type TransportPacket,
} from '@pingdost/protocol';

import { CALL_HISTORY_MAX, type CallHistoryEntry } from './calls';
import { createTestClient, eventually, FakeServer, type TestClient } from './testing';

let crypto: CryptoProvider;
const running: TestClient[] = [];

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const client of running.splice(0)) await client.engine.stop();
});

async function client(
  server: FakeServer,
  options: Parameters<typeof createTestClient>[2] = {},
): Promise<TestClient> {
  const created = await createTestClient(server, crypto, options);
  running.push(created);
  created.transport.connect();
  await created.engine.start();
  return created;
}

function received(c: TestClient): IncomingCallSignal[] {
  const list: IncomingCallSignal[] = [];
  c.engine.onCallSignal((s) => list.push(s));
  return list;
}

function offer(caller: TestClient, calleeDeviceId: string, callId = uuidv7()): CallSignalData {
  return {
    callId,
    type: 'offer',
    callerDeviceId: caller.deviceId,
    calleeDeviceId,
    video: true,
    sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
    expiresAt: Date.now() + 45_000,
  };
}

describe('call signaling', () => {
  it('rings every device of the callee and carries the answer back', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bobPhone = await client(server);
    const bobWeb = await client(server, { sameUserAs: bobPhone, platform: 'web' });
    const atPhone = received(bobPhone);
    const atWeb = received(bobWeb);
    const atAlice = received(alice);
    const flags: number[] = [];
    bobPhone.transport.onEphemeral((packet: TransportPacket) => flags.push(packet.flags));

    const devices = await alice.engine.callDevices(bobPhone.userId);
    expect(devices.sort()).toEqual([bobPhone.deviceId, bobWeb.deviceId].sort());
    const callId = uuidv7();
    for (const deviceId of devices) {
      const result = await alice.engine.sendCallSignal(
        bobPhone.userId,
        deviceId,
        offer(alice, deviceId, callId),
      );
      expect(result).toMatchObject({ ok: true });
    }
    await eventually(() => atPhone.length === 1 && atWeb.length === 1);
    expect(atPhone[0]).toMatchObject({
      fromUserId: alice.userId,
      fromDeviceId: alice.deviceId,
      signal: { callId, type: 'offer', video: true, calleeDeviceId: bobPhone.deviceId },
    });
    // Invites ask the server to ring an offline device (content-free `call` push).
    expect(flags[0]! & PacketFlag.RING).toBe(PacketFlag.RING);

    const answer: CallSignalData = {
      callId,
      type: 'answer',
      callerDeviceId: alice.deviceId,
      calleeDeviceId: bobWeb.deviceId,
      sdp: 'v=0\r\n',
    };
    expect(await bobWeb.engine.sendCallSignal(alice.userId, alice.deviceId, answer)).toMatchObject({
      ok: true,
    });
    await eventually(() => atAlice.length === 1);
    expect(atAlice[0]).toEqual({
      fromUserId: bobPhone.userId,
      fromDeviceId: bobWeb.deviceId,
      signal: answer,
    });

    // Other signals carry no RING flag.
    await alice.engine.sendCallSignal(bobPhone.userId, bobPhone.deviceId, {
      callId,
      type: 'hangup',
      callerDeviceId: alice.deviceId,
      calleeDeviceId: bobPhone.deviceId,
      reason: 'answered_elsewhere',
    });
    await eventually(() => atPhone.length === 2);
    expect(flags[1]! & PacketFlag.RING).toBe(0);
    expect(atPhone[1]!.signal.reason).toBe('answered_elsewhere');
  });

  it('refuses signals not bound to the two call devices, own devices and blocked users', async () => {
    const server = new FakeServer();
    const blocked = new Set<string>();
    const alice = await client(server);
    const aliceWeb = await client(server, { sameUserAs: alice, platform: 'web' });
    const bob = await client(server, { blocked: (userId) => blocked.has(userId) });
    const atBob = received(bob);

    // The signal names a device other than the one it is sent to.
    expect(
      await alice.engine.sendCallSignal(bob.userId, bob.deviceId, offer(alice, uuidv7())),
    ).toMatchObject({ ok: false, code: 'INVALID' });
    // No calls between one user's own devices.
    expect(
      await alice.engine.sendCallSignal(
        alice.userId,
        aliceWeb.deviceId,
        offer(alice, aliceWeb.deviceId),
      ),
    ).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });

    // Bob blocked Alice: her (relayed) invite is dropped by Bob's engine.
    blocked.add(alice.userId);
    expect(
      await alice.engine.sendCallSignal(bob.userId, bob.deviceId, offer(alice, bob.deviceId)),
    ).toMatchObject({ ok: true });
    await bob.engine.idle();
    expect(atBob).toEqual([]);
    // And Bob cannot call someone he blocked.
    expect(
      await bob.engine.sendCallSignal(alice.userId, alice.deviceId, {
        ...offer(bob, alice.deviceId),
      }),
    ).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  });

  it('answers RECIPIENT_OFFLINE for a callee device that is not connected', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    bob.transport.disconnect();
    expect(
      await alice.engine.sendCallSignal(bob.userId, bob.deviceId, offer(alice, bob.deviceId)),
    ).toMatchObject({ ok: false, code: 'RECIPIENT_OFFLINE', retryable: true });
  });

  it('keeps a local call history, newest first, replaced by call ID and capped', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const entry = (
      startedAt: number,
      fields: Partial<CallHistoryEntry> = {},
    ): CallHistoryEntry => ({
      callId: uuidv7(),
      peerUserId: uuidv7(),
      direction: 'out',
      video: false,
      startedAt,
      durationMs: 0,
      outcome: 'no_answer',
      ...fields,
    });
    const first = entry(1_000);
    await alice.engine.recordCall(first);
    await alice.engine.recordCall(entry(2_000));
    await alice.engine.recordCall({ ...first, outcome: 'completed', durationMs: 5_000 });
    const history = await alice.engine.callHistory();
    expect(history.map((e) => e.startedAt)).toEqual([2_000, 1_000]);
    expect(history[1]).toMatchObject({ outcome: 'completed', durationMs: 5_000 });

    for (let i = 0; i < CALL_HISTORY_MAX + 5; i++) await alice.engine.recordCall(entry(10_000 + i));
    expect(await alice.engine.callHistory()).toHaveLength(CALL_HISTORY_MAX);
    await alice.engine.clearCallHistory();
    expect(await alice.engine.callHistory()).toEqual([]);
  });
});
