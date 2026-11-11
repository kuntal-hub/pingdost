/**
 * Abuse limits added or re-checked in Phase 27 (REQ §18): never-delivered queue growth is
 * bounded per sender, and a WebSocket frame flood is answered RATE_LIMITED without hurting
 * the server. The other abuse cases have their own tests:
 * - mass large uploads: attachments.int.test.ts ("enforces the size limit, the quota…");
 * - OTP and login brute force: auth-register / auth-session.int.test.ts;
 * - pairing spam: pairing.int.test.ts ("limits how often one address…");
 * - mesh spam: packages/message-engine/src/mesh/mesh.test.ts (rate limits, quotas).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { Accepted_Status } from '@pingdost/protocol';

import { cryptoProvider } from './devices';
import { linkUsers, startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket } from './ws';

let crypto: CryptoProvider;
let server: TestServer;

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    throttles: {
      storedPerRecipientDevice: { limit: 3, windowMs: 60_000 },
      storedBytesPerSender: { limit: 5_000, windowMs: 60_000 },
    },
    gateway: { maxFrames: 12, rateWindowMs: 60_000 },
    delivery: { settings: { onlineAckTimeoutMs: 2_000 } },
  });
});

afterAll(async () => {
  await server.close();
});

describe('never-delivered queues (per-sender mailbox budget)', () => {
  it('stores a bounded number of envelopes per recipient device, per sender', async () => {
    const alice = await deviceSession(server, crypto);
    const dave = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto); // offline throughout the first part
    await linkUsers(server, alice, bob);
    await linkUsers(server, dave, bob);
    const aliceSocket = await TestSocket.connect(server, alice);

    for (let i = 0; i < 3; i++) {
      const { packet } = envelopePacket(server, alice.deviceId, bob.deviceId);
      expect(await aliceSocket.reply(aliceSocket.sendPacket(packet))).toMatchObject({
        case: 'accepted',
        value: { status: Accepted_Status.STORED },
      });
    }
    const fourth = envelopePacket(server, alice.deviceId, bob.deviceId);
    expect(await aliceSocket.reply(aliceSocket.sendPacket(fourth.packet))).toMatchObject({
      case: 'error',
      value: { code: 'RATE_LIMITED' },
    });
    expect(
      await server.redis
        .client()
        .exists(`${server.mailbox.redisKeyPrefix}env:${fourth.envelopeId}`),
    ).toBe(0);

    // Another sender still reaches bob.
    const daveSocket = await TestSocket.connect(server, dave);
    const fromDave = envelopePacket(server, dave.deviceId, bob.deviceId);
    expect(await daveSocket.reply(daveSocket.sendPacket(fromDave.packet))).toMatchObject({
      case: 'accepted',
      value: { status: Accepted_Status.STORED },
    });

    // Online deliveries are not counted: once bob is connected, alice reaches him again.
    const bobSocket = await TestSocket.connect(server, bob);
    const pending = await bobSocket.delivered(500);
    expect(pending).toHaveLength(4);
    bobSocket.ack(pending);
    const online = envelopePacket(server, alice.deviceId, bob.deviceId);
    const requestId = aliceSocket.sendPacket(online.packet);
    await bobSocket.next('deliver');
    bobSocket.ack([online.envelopeId]);
    expect(await aliceSocket.reply(requestId)).toMatchObject({
      case: 'accepted',
      value: { status: Accepted_Status.DELIVERED_TRANSPORT },
    });

    // The window ends; the sender's outbox retry then gets through.
    bobSocket.close();
    await bobSocket.closed();
    server.clock.advance(60_001);
    expect(await aliceSocket.reply(aliceSocket.sendPacket(fourth.packet))).toMatchObject({
      case: 'accepted',
      value: { status: Accepted_Status.STORED },
    });
    aliceSocket.close();
    daveSocket.close();
  });

  it('bounds the ciphertext bytes one account leaves in the mailbox', async () => {
    const erin = await deviceSession(server, crypto);
    const carol = await deviceSession(server, crypto); // offline
    await linkUsers(server, erin, carol);
    const socket = await TestSocket.connect(server, erin);
    const big = () =>
      envelopePacket(server, erin.deviceId, carol.deviceId, {
        ciphertext: new Uint8Array(2_000).fill(7),
      });
    for (let i = 0; i < 2; i++) {
      expect(await socket.reply(socket.sendPacket(big().packet))).toMatchObject({
        case: 'accepted',
      });
    }
    expect(await socket.reply(socket.sendPacket(big().packet))).toMatchObject({
      case: 'error',
      value: { code: 'RATE_LIMITED' },
    });
    socket.close();
  });
});

describe('WebSocket flood', () => {
  it('answers frames over the budget with RATE_LIMITED and keeps the socket usable', async () => {
    const session = await deviceSession(server, crypto);
    const socket = await TestSocket.connect(server, session); // the Auth frame counts too
    const ids = Array.from({ length: 30 }, (_, nonce) =>
      socket.send({ body: { case: 'ping', value: { nonce } } }),
    );
    // Frames are handled in order: 11 pings fit the budget of 12, the other 19 are refused.
    for (const [index, requestId] of ids.entries()) {
      if (index < 11) {
        expect(await socket.next('pong', { requestId })).toMatchObject({ nonce: index });
      } else {
        expect(await socket.next('error', { requestId })).toMatchObject({ code: 'RATE_LIMITED' });
      }
    }
    expect(socket.closeCode).toBeUndefined();

    server.clock.advance(60_001);
    const after = socket.send({ body: { case: 'ping', value: { nonce: 99 } } });
    expect(await socket.next('pong', { requestId: after })).toMatchObject({ nonce: 99 });
    socket.close();
  });
});
