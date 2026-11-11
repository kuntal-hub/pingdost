/**
 * Deleting an account (Phase 27, ADR 0036; Google Play requires it): an email code, then
 * every device revoked and its mailbox emptied, the groups left (an owner hands over), blocks
 * both ways, sessions, codes, pending requests and the account record removed. Contacts get
 * "no such user" afterwards; messages they already sent elsewhere are not touched.
 */
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { uuidv7 } from '@pingdost/protocol';
import type { Group } from '@pingdost/shared-types';
import { SimClient, type SimClientOptions } from '@pingdost/sim-client';

import { cryptoProvider } from './devices';
import { bearer, json, MAILPIT_URL, otpFor, startTestServer, type TestServer } from './helpers';

let server: TestServer;
let crypto: CryptoProvider;
let port = 0;
const clients: SimClient[] = [];
const revoked: string[] = [];

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    onDeviceRevoked: [(deviceId) => revoked.push(deviceId)],
    throttles: { keyClaims: { limit: 10_000, windowMs: 3_600_000 } },
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  port = (server.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const client of clients) await client.stop().catch(() => undefined);
  await server.close();
});

function options(): SimClientOptions {
  return {
    endpoints: {
      api: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/v1/ws`,
      mailpit: MAILPIT_URL,
    },
    crypto,
    settings: { directoryMaxAgeMs: 0, receiptDelayMs: 50, retry: { baseMs: 200, maxMs: 1_000 } },
  };
}

async function sim(): Promise<SimClient> {
  const client = await SimClient.register(options());
  clients.push(client);
  return client;
}

const emailOf = (client: SimClient) => `${client.username}@sim.pingdost.localhost`;
const code = (response: { body: string }) => (JSON.parse(response.body) as { code?: string }).code;

function request(method: 'GET' | 'POST' | 'PUT', token: string, url: string, payload?: object) {
  return server.app.inject({
    method,
    url,
    headers: bearer(token),
    ...(payload ? { payload } : {}),
  });
}

async function until(condition: () => Promise<boolean>, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('account deletion', () => {
  it('needs the email code: a wrong one deletes nothing', async () => {
    const alice = await sim();
    expect((await request('POST', alice.accessToken, '/v1/me/delete/code')).statusCode).toBe(204);
    const otp = await otpFor(emailOf(alice));
    const refused = await request('POST', alice.accessToken, '/v1/me/delete', {
      otp: otp === '000000' ? '111111' : '000000',
    });
    expect(code(refused)).toBe('OTP_INVALID');
    expect((await request('GET', alice.accessToken, '/v1/me')).statusCode).toBe(200);
    expect(
      await server.mongo.db
        .collection<{ _id: string }>('users')
        .countDocuments({ _id: alice.userId }),
    ).toBe(1);
  });

  it('removes the account, its devices and mailboxes, its groups and blocks', async () => {
    const alice = await sim();
    const bob = await sim();
    const carol = await sim();
    const browser = await SimClient.linkedDevice(options(), alice);
    clients.push(browser);
    await bob.start();
    await SimClient.linkAll(alice, bob, carol);

    // A group alice owns; bob blocked her, she blocked carol.
    const groupId = uuidv7();
    const created = await request('POST', alice.accessToken, '/v1/groups', {
      groupId,
      memberUserIds: [bob.userId, carol.userId],
    });
    expect(created.statusCode).toBe(201);
    expect((await request('PUT', bob.accessToken, `/v1/blocks/${alice.userId}`)).statusCode).toBe(
      204,
    );
    expect((await request('PUT', alice.accessToken, `/v1/blocks/${carol.userId}`)).statusCode).toBe(
      204,
    );
    await request('PUT', bob.accessToken, `/v1/blocks/${carol.userId}`);

    // A message waits in the mailbox of alice's phone (it is offline).
    const { conversationId } = await bob.engine.openDirectConversation(alice.userId);
    await bob.engine.sendText(conversationId, 'are you there?');
    const mailbox = `${server.mailbox.redisKeyPrefix}mbx:${alice.deviceId}`;
    await until(async () => (await server.redis.client().zcard(mailbox)) > 0, 'a waiting message');

    expect((await request('POST', alice.accessToken, '/v1/me/delete/code')).statusCode).toBe(204);
    const otp = await otpFor(emailOf(alice));
    const deleted = await request('POST', alice.accessToken, '/v1/me/delete', { otp });
    expect(deleted.statusCode).toBe(204);

    // Devices revoked, mailboxes empty.
    expect(revoked).toEqual(expect.arrayContaining([alice.deviceId, browser.deviceId]));
    expect(await server.redis.client().zcard(mailbox)).toBe(0);
    const db = server.mongo.db;
    expect(
      await db.collection('pending_envelopes').countDocuments({
        recipientDeviceId: { $in: [alice.deviceId, browser.deviceId] },
      }),
    ).toBe(0);

    // The account and everything tied to it.
    expect(
      await db.collection<{ _id: string }>('users').countDocuments({ _id: alice.userId }),
    ).toBe(0);
    expect(await db.collection('devices').countDocuments({ userId: alice.userId })).toBe(0);
    expect(await db.collection('sessions').countDocuments({ userId: alice.userId })).toBe(0);
    expect(
      await db.collection('one_time_keys').countDocuments({
        deviceId: { $in: [alice.deviceId, browser.deviceId] },
      }),
    ).toBe(0);
    expect(
      await db.collection('blocks').countDocuments({
        $or: [{ blockerUserId: alice.userId }, { blockedUserId: alice.userId }],
      }),
    ).toBe(0);
    expect(await db.collection('circle_links').countDocuments({ users: alice.userId })).toBe(0);
    // Other people's blocks stay.
    expect(await db.collection('blocks').countDocuments({ blockerUserId: bob.userId })).toBe(1);
    expect(await db.collection('email_otps').countDocuments({ email: emailOf(alice) })).toBe(0);
    expect(
      await db.collection('security_events').countDocuments({
        userId: alice.userId,
        type: 'account_delete',
      }),
    ).toBe(1);

    // Her tokens stop working; contacts find no such user.
    expect((await request('GET', alice.accessToken, '/v1/me')).statusCode).toBe(401);
    expect(code(await request('GET', bob.accessToken, `/v1/keys/users/${alice.userId}`))).toBe(
      'NOT_FOUND',
    );
    expect(
      code(await request('GET', bob.accessToken, `/v1/users/by-username/${alice.username}`)),
    ).toBe('NOT_FOUND');

    // The group goes on without her; the longest-standing member owns it now.
    const group = json<Group>(await request('GET', bob.accessToken, `/v1/groups/${groupId}`));
    expect(group.members.map((m) => m.userId).sort()).toEqual([bob.userId, carol.userId].sort());
    expect(group.members.some((m) => m.role === 'owner')).toBe(true);
  });
});
