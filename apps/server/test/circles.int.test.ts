/**
 * Circles (Phase 37, ADR 0041): requests, accept, decline, withdraw, remove, expiry and limits;
 * what a stranger cannot do (message, call, claim keys, type, add to a group); group traffic
 * between co-members outside each other's circle; blocks and account deletion.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { bytesEqual, PacketFlag, PacketKind, uuidToBytes } from '@pingdost/protocol';
import { uuidv7 } from '@pingdost/protocol/ids';
import {
  CIRCLE_REQUEST_TTL_DAYS,
  MAX_PENDING_CIRCLE_REQUESTS,
  type CircleMember,
  type CircleRequestsResponse,
} from '@pingdost/shared-types';

import { cryptoProvider } from './devices';
import { bearer, json, linkUsers, otpFor, startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket, type TestDeviceSession } from './ws';

let server: TestServer;
let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    delivery: { settings: { onlineAckTimeoutMs: 400 } },
    // Room for the limit tests: the daily budget is tested on its own server below.
    throttles: { circleRequests: { limit: 10_000, windowMs: 86_400_000 } },
  });
});

afterAll(async () => {
  await server.close();
});

type Who = TestDeviceSession;

function call(who: Who, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  return server.app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload ? { payload } : {}),
  });
}

const ask = (from: Who, to: Who) =>
  call(from, 'POST', '/v1/circle/requests', { userId: to.userId });
const accept = (who: Who, from: Who) =>
  call(who, 'POST', `/v1/circle/requests/${from.userId}/accept`);
const decline = (who: Who, from: Who) =>
  call(who, 'POST', `/v1/circle/requests/${from.userId}/decline`);
const withdraw = (who: Who, to: Who) => call(who, 'DELETE', `/v1/circle/requests/${to.userId}`);
const remove = (who: Who, other: Who) => call(who, 'DELETE', `/v1/circle/${other.userId}`);

async function circleOf(who: Who): Promise<string[]> {
  const response = await call(who, 'GET', '/v1/circle');
  expect(response.statusCode).toBe(200);
  return json<{ members: CircleMember[] }>(response).members.map((m) => m.userId);
}

async function requestsOf(who: Who): Promise<{ incoming: string[]; outgoing: string[] }> {
  const response = await call(who, 'GET', '/v1/circle/requests');
  expect(response.statusCode).toBe(200);
  const body = json<CircleRequestsResponse>(response);
  return {
    incoming: body.incoming.map((r) => r.userId),
    outgoing: body.outgoing.map((r) => r.userId),
  };
}

/** Waits for a `CircleChanged` frame naming `userId`. */
async function changed(socket: TestSocket, userId: string): Promise<void> {
  const id = uuidToBytes(userId);
  for (;;) {
    const frame = await socket.next('circleChanged');
    if (bytesEqual(frame.userId, id)) return;
  }
}

describe('requests', () => {
  it('request → accept links both ways, with live updates and public profiles only', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const aliceSocket = await TestSocket.connect(server, alice);
    const bobSocket = await TestSocket.connect(server, bob);

    const asked = await ask(alice, bob);
    expect(asked.statusCode).toBe(200);
    expect(json(asked)).toEqual({ status: 'requested' });
    await changed(bobSocket, alice.userId);
    expect(await requestsOf(alice)).toEqual({ incoming: [], outgoing: [bob.userId] });
    expect(await requestsOf(bob)).toEqual({ incoming: [alice.userId], outgoing: [] });
    // Asking again changes nothing.
    expect(json(await ask(alice, bob))).toEqual({ status: 'requested' });

    const incoming = json<CircleRequestsResponse>(await call(bob, 'GET', '/v1/circle/requests'));
    expect(Object.keys(incoming.incoming[0]!).sort()).toEqual(
      ['avatarUrl', 'createdAt', 'displayName', 'expiresAt', 'userId', 'username'].sort(),
    );
    expect(incoming.incoming[0]!.expiresAt - incoming.incoming[0]!.createdAt).toBe(
      CIRCLE_REQUEST_TTL_DAYS * 86_400_000,
    );

    expect((await accept(bob, alice)).statusCode).toBe(204);
    await changed(aliceSocket, bob.userId);
    expect(await circleOf(alice)).toEqual([bob.userId]);
    expect(await circleOf(bob)).toEqual([alice.userId]);
    expect(await requestsOf(alice)).toEqual({ incoming: [], outgoing: [] });
    expect(json(await ask(bob, alice))).toEqual({ status: 'linked' });
    aliceSocket.close();
    bobSocket.close();
  });

  it('asking someone who asked first links at once', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    await ask(alice, bob);
    expect(json(await ask(bob, alice))).toEqual({ status: 'linked' });
    expect(await circleOf(alice)).toEqual([bob.userId]);
  });

  it('declining is silent: the sender keeps seeing "requested"', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const aliceSocket = await TestSocket.connect(server, alice);
    await ask(alice, bob);
    await changed(aliceSocket, bob.userId);
    expect((await decline(bob, alice)).statusCode).toBe(204);
    expect(await requestsOf(bob)).toEqual({ incoming: [], outgoing: [] });
    expect(await requestsOf(alice)).toEqual({ incoming: [], outgoing: [bob.userId] });
    // Alice's sockets are not told.
    await expect(aliceSocket.next('circleChanged', { timeoutMs: 300 })).rejects.toThrow();
    expect(json(await ask(alice, bob))).toEqual({ status: 'requested' });
    // A declined request cannot be accepted any more; asking back links (a change of mind).
    expect((await accept(bob, alice)).statusCode).toBe(404);
    expect(json(await ask(bob, alice))).toEqual({ status: 'linked' });
    aliceSocket.close();
  });

  it('withdraws a request', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    await ask(alice, bob);
    expect((await withdraw(alice, bob)).statusCode).toBe(204);
    expect(await requestsOf(bob)).toEqual({ incoming: [], outgoing: [] });
    expect(await requestsOf(alice)).toEqual({ incoming: [], outgoing: [] });
    expect((await accept(bob, alice)).statusCode).toBe(404);
  });

  it('either side removes the link; both lists refresh', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    await linkUsers(server, alice, bob);
    const aliceSocket = await TestSocket.connect(server, alice);
    expect((await remove(bob, alice)).statusCode).toBe(204);
    await changed(aliceSocket, bob.userId);
    expect(await circleOf(alice)).toEqual([]);
    expect(await circleOf(bob)).toEqual([]);
    expect((await remove(bob, alice)).statusCode).toBe(204);
    aliceSocket.close();
  });

  it('expires requests after 30 days; the sender may ask again', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    await ask(alice, bob);
    // Thirty days pass for the request (the server's clock cannot jump: tokens would expire).
    const past = server.clock.now() - CIRCLE_REQUEST_TTL_DAYS * 86_400_000 - 1_000;
    await server.mongo.db
      .collection<{ _id: string; createdAt: Date; expiresAt: Date }>('circle_requests')
      .updateOne(
        { _id: `${alice.userId}:${bob.userId}` },
        { $set: { createdAt: new Date(past), expiresAt: new Date(server.clock.now() - 1_000) } },
      );
    expect(await requestsOf(bob)).toEqual({ incoming: [], outgoing: [] });
    expect(await requestsOf(alice)).toEqual({ incoming: [], outgoing: [] });
    expect((await accept(bob, alice)).statusCode).toBe(404);
    expect(json(await ask(alice, bob))).toEqual({ status: 'requested' });
    expect(await requestsOf(bob)).toEqual({ incoming: [alice.userId], outgoing: [] });
    // The TTL index removes them from Mongo on its own.
    const indexes = await server.mongo.db.collection('circle_requests').indexes();
    expect(indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0)).toBe(true);
  });

  it('refuses oneself, unknown users and more than the pending limit', async () => {
    const alice = await deviceSession(server, crypto);
    expect((await ask(alice, alice)).statusCode).toBe(400);
    const unknown = await call(alice, 'POST', '/v1/circle/requests', { userId: uuidv7() });
    expect(unknown.statusCode).toBe(404);

    // Fill the pending limit with direct inserts (registering 100 users is slow).
    const now = server.clock.now();
    await server.mongo.db.collection('circle_requests').insertMany(
      Array.from({ length: MAX_PENDING_CIRCLE_REQUESTS }, () => {
        const to = randomUUID();
        return {
          _id: `${alice.userId}:${to}` as unknown as never,
          from: alice.userId,
          to,
          createdAt: new Date(now),
          expiresAt: new Date(now + 86_400_000),
          declined: false,
        };
      }),
    );
    const bob = await deviceSession(server, crypto);
    const full = await ask(alice, bob);
    expect(full.statusCode).toBe(409);
    expect(json(full)).toMatchObject({ code: 'CIRCLE_LIMIT_REACHED' });
  });

  it('limits new requests per day', async () => {
    const limited = await startTestServer({
      throttles: { circleRequests: { limit: 2, windowMs: 86_400_000 } },
    });
    try {
      const [alice, b, c, d] = await Promise.all(
        Array.from({ length: 4 }, () => deviceSession(limited, crypto)),
      );
      const send = (to: Who) =>
        limited.app.inject({
          method: 'POST',
          url: '/v1/circle/requests',
          headers: bearer(alice!.accessToken),
          payload: { userId: to.userId },
        });
      expect((await send(b!)).statusCode).toBe(200);
      expect((await send(c!)).statusCode).toBe(200);
      // Repeating one does not count.
      expect((await send(b!)).statusCode).toBe(200);
      const third = await send(d!);
      expect(third.statusCode).toBe(429);
      expect(json(third)).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await limited.close();
    }
  });
});

describe('what a stranger cannot do', () => {
  it('refuses messages, key claims, call rings, typing and presence; group adds too', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const aliceSocket = await TestSocket.connect(server, alice);
    const bobSocket = await TestSocket.connect(server, bob);

    // A one-to-one envelope.
    const message = envelopePacket(server, alice.deviceId, bob.deviceId);
    expect(await aliceSocket.reply(aliceSocket.sendPacket(message.packet))).toMatchObject({
      case: 'error',
      value: { code: 'NOT_IN_CIRCLE', retryable: false },
    });
    expect(await bobSocket.delivered(300)).toEqual([]);

    // A key claim (the first message's session).
    const claim = await call(alice, 'POST', '/v1/keys/claim', { deviceIds: [bob.deviceId] });
    expect(claim.statusCode).toBe(403);
    expect(json(claim)).toMatchObject({ code: 'NOT_IN_CIRCLE' });

    // A call invite (EPHEMERAL with RING), to an online device.
    const ring = envelopePacket(server, alice.deviceId, bob.deviceId, {
      kind: PacketKind.EPHEMERAL,
    });
    ring.packet.flags = PacketFlag.RING;
    expect(
      await aliceSocket.reply(
        aliceSocket.send({ body: { case: 'ephemeral', value: { packet: ring.packet } } }),
      ),
    ).toMatchObject({ case: 'error', value: { code: 'NOT_IN_CIRCLE' } });

    // Typing and presence, even with the chat open on both sides.
    for (const [socket, other] of [
      [aliceSocket, bob],
      [bobSocket, alice],
    ] as const) {
      socket.send({
        body: {
          case: 'presence',
          value: { online: true, watchUserIds: [uuidToBytes(other.userId)] },
        },
      });
    }
    const presence = await bobSocket.next('presence');
    expect(presence.online).toBe(false);
    aliceSocket.send({
      body: {
        case: 'typing',
        value: { recipientDeviceIds: [uuidToBytes(bob.deviceId)], active: true },
      },
    });
    await expect(bobSocket.next('typing', { timeoutMs: 400 })).rejects.toThrow();

    // Group create and add name only people in the adder's circle.
    const groupId = uuidv7();
    const create = await call(alice, 'POST', '/v1/groups', {
      groupId,
      memberUserIds: [bob.userId],
    });
    expect(create.statusCode).toBe(403);
    expect(json(create)).toMatchObject({ code: 'NOT_IN_CIRCLE' });

    // Once linked, all of it works.
    await linkUsers(server, alice, bob);
    const after = envelopePacket(server, alice.deviceId, bob.deviceId);
    aliceSocket.sendPacket(after.packet);
    expect((await bobSocket.next('deliver')).packet?.packetId).toEqual(after.packet.packetId);
    bobSocket.ack([after.envelopeId]);
    aliceSocket.send({
      body: {
        case: 'typing',
        value: { recipientDeviceIds: [uuidToBytes(bob.deviceId)], active: true },
      },
    });
    expect((await bobSocket.next('typing')).active).toBe(true);
    // Removal stops it again at once (the cache follows every change).
    await remove(bob, alice);
    const removed = envelopePacket(server, alice.deviceId, bob.deviceId);
    expect(await aliceSocket.reply(aliceSocket.sendPacket(removed.packet))).toMatchObject({
      case: 'error',
      value: { code: 'NOT_IN_CIRCLE' },
    });
    aliceSocket.close();
    bobSocket.close();
  });

  it('lets co-members outside each other’s circle exchange group traffic, not calls', async () => {
    const owner = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const carol = await deviceSession(server, crypto);
    await linkUsers(server, owner, bob);
    await linkUsers(server, owner, carol);
    const groupId = uuidv7();
    const created = await call(owner, 'POST', '/v1/groups', {
      groupId,
      memberUserIds: [bob.userId, carol.userId],
    });
    expect(created.statusCode).toBe(201);

    const bobSocket = await TestSocket.connect(server, bob);
    const carolSocket = await TestSocket.connect(server, carol);
    // A Megolm message, and a one-to-one envelope (a group receipt or room key) between them.
    const megolm = envelopePacket(server, bob.deviceId, carol.deviceId, { groupId });
    bobSocket.sendPacket(megolm.packet);
    expect((await carolSocket.next('deliver')).packet?.packetId).toEqual(megolm.packet.packetId);
    carolSocket.ack([megolm.envelopeId]);
    const receipt = envelopePacket(server, carol.deviceId, bob.deviceId);
    carolSocket.sendPacket(receipt.packet);
    expect((await bobSocket.next('deliver')).packet?.packetId).toEqual(receipt.packet.packetId);
    bobSocket.ack([receipt.envelopeId]);
    // Their keys too (sessions for room keys).
    const claim = await call(bob, 'POST', '/v1/keys/claim', { deviceIds: [carol.deviceId] });
    expect(claim.statusCode).toBe(200);
    // Typing inside the group reaches a co-member who has it open.
    carolSocket.send({
      body: { case: 'presence', value: { online: true, watchUserIds: [uuidToBytes(bob.userId)] } },
    });
    await carolSocket.next('presence');
    bobSocket.send({
      body: {
        case: 'typing',
        value: {
          recipientDeviceIds: [uuidToBytes(carol.deviceId)],
          groupId: uuidToBytes(groupId),
          active: true,
        },
      },
    });
    expect((await carolSocket.next('typing')).active).toBe(true);
    // But no call, and no adding each other to another group.
    const ring = envelopePacket(server, bob.deviceId, carol.deviceId, {
      kind: PacketKind.EPHEMERAL,
    });
    ring.packet.flags = PacketFlag.RING;
    expect(
      await bobSocket.reply(
        bobSocket.send({ body: { case: 'ephemeral', value: { packet: ring.packet } } }),
      ),
    ).toMatchObject({ case: 'error', value: { code: 'NOT_IN_CIRCLE' } });
    const other = await call(bob, 'POST', '/v1/groups', {
      groupId: uuidv7(),
      memberUserIds: [carol.userId],
    });
    expect(json(other)).toMatchObject({ code: 'NOT_IN_CIRCLE' });

    // Once carol leaves the group, the one-to-one path closes too.
    expect(
      (await call(carol, 'DELETE', `/v1/groups/${groupId}/members/${carol.userId}`)).statusCode,
    ).toBe(200);
    const late = envelopePacket(server, bob.deviceId, carol.deviceId);
    expect(await bobSocket.reply(bobSocket.sendPacket(late.packet))).toMatchObject({
      case: 'error',
      value: { code: 'NOT_IN_CIRCLE' },
    });
    bobSocket.close();
    carolSocket.close();
  });

  it('names refused devices in a mixed key claim', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const stranger = await deviceSession(server, crypto);
    await linkUsers(server, alice, bob);
    const response = await call(alice, 'POST', '/v1/keys/claim', {
      deviceIds: [bob.deviceId, stranger.deviceId],
    });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toMatchObject({ refusedDeviceIds: [stranger.deviceId] });
  });
});

describe('blocks and account deletion', () => {
  it('a block clears the link and the requests both ways', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const carol = await deviceSession(server, crypto);
    await linkUsers(server, alice, bob);
    await ask(carol, alice);
    const block = (who: Who, userId: string) =>
      server.app.inject({
        method: 'PUT',
        url: `/v1/blocks/${userId}`,
        headers: bearer(who.accessToken),
      });

    expect((await block(alice, bob.userId)).statusCode).toBe(204);
    expect((await block(alice, carol.userId)).statusCode).toBe(204);
    expect(await circleOf(alice)).toEqual([]);
    expect(await circleOf(bob)).toEqual([]);
    expect(await requestsOf(alice)).toEqual({ incoming: [], outgoing: [] });
    expect(await requestsOf(carol)).toEqual({ incoming: [], outgoing: [] });

    // Bob asks again: he sees "requested", alice never sees it.
    expect(json(await ask(bob, alice))).toEqual({ status: 'requested' });
    expect(await requestsOf(alice)).toEqual({ incoming: [], outgoing: [] });
    expect(await requestsOf(bob)).toEqual({ incoming: [], outgoing: [alice.userId] });
    // Alice must unblock before asking bob.
    expect((await ask(alice, carol)).statusCode).toBe(409);
  });

  it('account deletion removes its links and requests', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const carol = await deviceSession(server, crypto);
    await linkUsers(server, alice, bob);
    await ask(alice, carol);
    const bobSocket = await TestSocket.connect(server, bob);

    expect((await call(alice, 'POST', '/v1/me/delete/code')).statusCode).toBe(204);
    const email = (await server.mongo.db
      .collection<{ _id: string; email: string }>('users')
      .findOne({ _id: alice.userId }))!.email;
    const deleted = await call(alice, 'POST', '/v1/me/delete', {
      otp: await otpFor(email, 2),
    });
    expect(deleted.statusCode).toBe(204);
    await changed(bobSocket, alice.userId);
    expect(await circleOf(bob)).toEqual([]);
    expect(await requestsOf(carol)).toEqual({ incoming: [], outgoing: [] });
    const db = server.mongo.db;
    expect(await db.collection('circle_links').countDocuments({ users: alice.userId })).toBe(0);
    expect(
      await db
        .collection('circle_requests')
        .countDocuments({ $or: [{ from: alice.userId }, { to: alice.userId }] }),
    ).toBe(0);
    bobSocket.close();
  });
});
