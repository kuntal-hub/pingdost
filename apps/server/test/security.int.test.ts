/**
 * Blocks and reports (Phase 11, ADR 0014): a blocked sender's envelopes are answered as
 * stored and dropped; typing and presence stop; lookups still work; reports keep only what
 * the reporter attached, with a retention TTL, and never reach the logs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { Accepted_Status, bytesEqual, uuidToBytes } from '@pingdost/protocol';

import { cryptoProvider } from './devices';
import { bearer, json, startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket, type TestDeviceSession } from './ws';

let server: TestServer;
let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    env: { ABUSE_REPORT_RETENTION_SECONDS: String(30 * 86_400) },
    delivery: { settings: { onlineAckTimeoutMs: 400 } },
  });
});

afterAll(async () => {
  await server.close();
});

function block(by: TestDeviceSession, userId: string, method: 'PUT' | 'DELETE' = 'PUT') {
  return server.app.inject({
    method,
    url: `/v1/blocks/${userId}`,
    headers: bearer(by.accessToken),
  });
}

async function blockList(of: TestDeviceSession): Promise<string[]> {
  const response = await server.app.inject({
    method: 'GET',
    url: '/v1/blocks',
    headers: bearer(of.accessToken),
  });
  expect(response.statusCode).toBe(200);
  return json<{ userIds: string[] }>(response).userIds;
}

/** Waits for the frame saying userId is (not) online; earlier states are skipped. */
async function presenceOf(socket: TestSocket, userId: string, online: boolean): Promise<void> {
  const id = uuidToBytes(userId);
  for (;;) {
    const frame = await socket.next('presence');
    if (bytesEqual(frame.userId, id) && frame.online === online) return;
  }
}

function watch(socket: TestSocket, userId: string): void {
  socket.send({
    requestId: 0,
    body: { case: 'presence', value: { online: true, watchUserIds: [uuidToBytes(userId)] } },
  });
}

describe('blocks', () => {
  it('lists, adds and removes blocks idempotently', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    expect(await blockList(alice)).toEqual([]);
    expect((await block(alice, bob.userId)).statusCode).toBe(204);
    expect((await block(alice, bob.userId)).statusCode).toBe(204);
    expect(await blockList(alice)).toEqual([bob.userId]);
    expect(await blockList(bob)).toEqual([]);

    expect((await block(alice, alice.userId)).statusCode).toBe(400);
    const unknown = await block(alice, '01920000-0000-7000-8000-00000000beef');
    expect(unknown.statusCode).toBe(404);
    expect(json(unknown)).toMatchObject({ code: 'NOT_FOUND' });

    expect((await block(alice, bob.userId, 'DELETE')).statusCode).toBe(204);
    expect((await block(alice, bob.userId, 'DELETE')).statusCode).toBe(204);
    expect(await blockList(alice)).toEqual([]);
  });

  it('drops envelopes from a blocked sender, answering them as stored', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const aliceSocket = await TestSocket.connect(server, alice);
    const bobSocket = await TestSocket.connect(server, bob);
    expect((await block(alice, bob.userId)).statusCode).toBe(204);

    // Online: alice's socket never sees it; bob gets the same answer as any stored send.
    const online = envelopePacket(server, bob.deviceId, alice.deviceId);
    expect(await bobSocket.reply(bobSocket.sendPacket(online.packet))).toMatchObject({
      case: 'accepted',
      value: { status: Accepted_Status.STORED, envelopeId: uuidToBytes(online.envelopeId) },
    });
    expect(await aliceSocket.delivered(300)).toEqual([]);

    // Offline: nothing is stored for alice to fetch later.
    aliceSocket.close();
    const offline = envelopePacket(server, bob.deviceId, alice.deviceId);
    expect(await bobSocket.reply(bobSocket.sendPacket(offline.packet))).toMatchObject({
      case: 'accepted',
      value: { status: Accepted_Status.STORED },
    });
    expect(await server.mongo.db.collection('pending_envelopes').countDocuments()).toBe(0);
    for (const id of [online.envelopeId, offline.envelopeId]) {
      expect(await server.redis.client().exists(`${server.mailbox.redisKeyPrefix}env:${id}`)).toBe(
        0,
      );
    }
    const reconnected = await TestSocket.connect(server, alice);
    expect(await reconnected.delivered(300)).toEqual([]);

    // Alice can still write to bob; after unblocking, bob's sends arrive again.
    const reply = envelopePacket(server, alice.deviceId, bob.deviceId);
    reconnected.sendPacket(reply.packet);
    expect((await bobSocket.next('deliver')).packet?.packetId).toEqual(reply.packet.packetId);
    bobSocket.ack([reply.envelopeId]);
    expect((await block(alice, bob.userId, 'DELETE')).statusCode).toBe(204);
    const after = envelopePacket(server, bob.deviceId, alice.deviceId);
    bobSocket.sendPacket(after.packet);
    expect((await reconnected.next('deliver')).packet?.packetId).toEqual(after.packet.packetId);
    reconnected.ack([after.envelopeId]);
    reconnected.close();
    bobSocket.close();
  });

  it('stops typing and presence both ways; lookups still work', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const aliceSocket = await TestSocket.connect(server, alice);
    const bobSocket = await TestSocket.connect(server, bob);
    watch(aliceSocket, bob.userId);
    watch(bobSocket, alice.userId);
    await presenceOf(aliceSocket, bob.userId, true);
    await presenceOf(bobSocket, alice.userId, true);

    expect((await block(alice, bob.userId)).statusCode).toBe(204);
    // Each side's watch now reports the other offline.
    await presenceOf(bobSocket, alice.userId, false);
    await presenceOf(aliceSocket, bob.userId, false);
    const typing = (from: TestSocket, to: TestDeviceSession) =>
      from.send({
        requestId: 0,
        body: {
          case: 'typing',
          value: { recipientDeviceIds: [uuidToBytes(to.deviceId)], active: true },
        },
      });
    typing(bobSocket, alice);
    typing(aliceSocket, bob);
    await expect(aliceSocket.next('typing', { timeoutMs: 300 })).rejects.toThrow();
    await expect(bobSocket.next('typing', { timeoutMs: 300 })).rejects.toThrow();

    // The blocked user can still find the blocker.
    const me = json<{ username: string }>(
      await server.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(alice.accessToken) }),
    );
    const byName = await server.app.inject({
      method: 'GET',
      url: `/v1/users/by-username/${me.username}`,
      headers: bearer(bob.accessToken),
    });
    expect(byName.statusCode).toBe(200);
    const byId = await server.app.inject({
      method: 'GET',
      url: `/v1/users/${alice.userId}`,
      headers: bearer(bob.accessToken),
    });
    expect(byId.statusCode).toBe(200);

    expect((await block(alice, bob.userId, 'DELETE')).statusCode).toBe(204);
    typing(bobSocket, alice);
    expect(await aliceSocket.next('typing')).toMatchObject({
      senderDeviceId: uuidToBytes(bob.deviceId),
    });
    aliceSocket.close();
    bobSocket.close();
  });
});

describe('reports', () => {
  it('stores a report with only the messages the reporter attached, with a TTL', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const report = (body: unknown, by = alice) =>
      server.app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: bearer(by.accessToken),
        payload: body as Record<string, unknown>,
      });

    const bare = await report({ reportedUserId: bob.userId, reason: 'spam' });
    expect(bare.statusCode).toBe(201);
    const marker = `report-marker-${Date.now()}`;
    const withMessages = await report({
      reportedUserId: bob.userId,
      reason: 'harassment',
      details: `  ${marker} details  `,
      messages: [
        {
          messageId: '01920000-0000-7000-8000-000000000001',
          senderUserId: bob.userId,
          sentAt: 1_700_000_000_000,
          text: `${marker} the abusive text`,
        },
        {
          messageId: '01920000-0000-7000-8000-000000000002',
          senderUserId: alice.userId,
          sentAt: 1_700_000_000_500,
          text: 'please stop',
        },
      ],
    });
    expect(withMessages.statusCode).toBe(201);
    const { reportId } = json<{ reportId: string }>(withMessages);

    const reports = server.mongo.db.collection('abuse_reports');
    const stored = await reports.findOne({ _id: reportId as never });
    expect(stored).toMatchObject({
      reporterUserId: alice.userId,
      reportedUserId: bob.userId,
      reason: 'harassment',
      details: `${marker} details`,
    });
    expect(stored?.messages).toHaveLength(2);
    const created = (stored?.createdAt as Date).getTime();
    expect((stored?.expiresAt as Date).getTime() - created).toBe(30 * 86_400_000);
    const bareDoc = await reports.findOne({
      _id: json<{ reportId: string }>(bare).reportId as never,
    });
    expect(bareDoc).toMatchObject({ messages: [], details: null });
    const ttl = (await reports.indexes()).find((index) => index.key.expiresAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(0);

    // Disclosed plaintext never reaches a log line.
    expect(server.logs.some((line) => line.includes(marker))).toBe(false);
  });

  it('refuses self-reports, unknown users, foreign messages and too many messages', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const carol = await deviceSession(server, crypto);
    const post = (payload: Record<string, unknown>) =>
      server.app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: bearer(alice.accessToken),
        payload,
      });
    const message = (senderUserId: string, n = 1) => ({
      messageId: `01920000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
      senderUserId,
      sentAt: 1_700_000_000_000,
      text: 'x',
    });
    expect((await post({ reportedUserId: alice.userId, reason: 'spam' })).statusCode).toBe(400);
    expect(
      (await post({ reportedUserId: '01920000-0000-7000-8000-00000000beef', reason: 'spam' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await post({
          reportedUserId: bob.userId,
          reason: 'spam',
          messages: [message(carol.userId)],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          reportedUserId: bob.userId,
          reason: 'spam',
          messages: Array.from({ length: 21 }, (_, i) => message(bob.userId, i + 1)),
        })
      ).statusCode,
    ).toBe(400);
    expect((await post({ reportedUserId: bob.userId, reason: 'nope' })).statusCode).toBe(400);
  });
});

describe('privacy preferences', () => {
  it('defaults delivery receipts on and lets the user turn them off', async () => {
    const alice = await deviceSession(server, crypto);
    const me = await server.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(alice.accessToken),
    });
    expect(json<{ privacy: Record<string, boolean> }>(me).privacy.deliveryReceipts).toBe(true);
    // An account stored before the preference existed reads as the default.
    await server.mongo.db
      .collection('users')
      .updateOne({ _id: alice.userId as never }, { $unset: { 'privacy.deliveryReceipts': '' } });
    const legacy = await server.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(alice.accessToken),
    });
    expect(json<{ privacy: Record<string, boolean> }>(legacy).privacy.deliveryReceipts).toBe(true);
    const off = await server.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(alice.accessToken),
      payload: { privacy: { deliveryReceipts: false } },
    });
    expect(json<{ privacy: Record<string, boolean> }>(off).privacy).toMatchObject({
      deliveryReceipts: false,
      readReceipts: true,
    });
  });
});
