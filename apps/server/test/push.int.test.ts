/**
 * Push wakes (Phase 12, ADR 0015): token registration, and an offline send waking the
 * recipient through the real FCM sender against a fake Google, whose request bodies prove the
 * push carries nothing but `{"t":"wake"}`.
 */
import { generateKeyPairSync } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { Accepted_Status } from '@pingdost/protocol';

import { cryptoProvider } from './devices';
import { bearer, json, registeredUser, startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket, type TestDeviceSession } from './ws';
import { systemClock } from '../src/infra/clock';
import { FcmSender } from '../src/modules/push/fcm';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** Every FCM send the server made, as raw request bodies. */
const fcmBodies: string[] = [];
const deadTokens = new Set<string>();

const fakeGoogle = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://oauth2.googleapis.com/token') {
    return Promise.resolve(Response.json({ access_token: 'access', expires_in: 3600 }));
  }
  const body = typeof init?.body === 'string' ? init.body : '';
  fcmBodies.push(body);
  const { message } = JSON.parse(body) as { message: { token: string } };
  if (deadTokens.has(message.token)) {
    const unregistered = Response.json(
      {
        error: {
          code: 404,
          status: 'NOT_FOUND',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'UNREGISTERED',
            },
          ],
        },
      },
      { status: 404 },
    );
    return Promise.resolve(unregistered);
  }
  return Promise.resolve(Response.json({ name: 'projects/pingdost-test/messages/1' }));
}) as typeof fetch;

let server: TestServer;
let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    env: { PUSH_WAKE_THROTTLE_SECONDS: '1' },
    pushSenders: {
      fcm: new FcmSender({
        projectId: 'pingdost-test',
        serviceAccountJsonBase64: Buffer.from(
          JSON.stringify({
            client_email: 'fcm@test.iam.gserviceaccount.com',
            private_key: privateKey,
          }),
        ).toString('base64'),
        ttlSeconds: 3_600,
        clock: systemClock,
        fetch: fakeGoogle,
      }),
    },
  });
});

afterAll(() => server.close());

function putToken(session: { accessToken: string }, token: string) {
  return server.app.inject({
    method: 'PUT',
    url: '/v1/push/token',
    headers: bearer(session.accessToken),
    payload: { provider: 'fcm', token },
  });
}

const tokens = () => server.mongo.db.collection<{ _id: string; address: string }>('push_tokens');

async function sendStored(socket: TestSocket, from: TestDeviceSession, to: TestDeviceSession) {
  const marker = new TextEncoder().encode('PLAINTEXT-MARKER-push');
  const built = envelopePacket(server, from.deviceId, to.deviceId, { ciphertext: marker });
  const reply = await socket.reply(socket.sendPacket(built.packet));
  expect(reply).toMatchObject({ case: 'accepted', value: { status: Accepted_Status.STORED } });
  return built;
}

describe('push tokens', () => {
  it('registers, replaces and deletes the calling device’s token', async () => {
    const bob = await deviceSession(server, crypto);
    expect((await putToken(bob, 'token-a')).statusCode).toBe(204);
    expect((await putToken(bob, 'token-b')).statusCode).toBe(204);
    expect(await tokens().findOne({ _id: bob.deviceId })).toMatchObject({
      address: 'token-b',
      provider: 'fcm',
      userId: bob.userId,
    });

    const deleted = await server.app.inject({
      method: 'DELETE',
      url: '/v1/push/token',
      headers: bearer(bob.accessToken),
    });
    expect(deleted.statusCode).toBe(204);
    expect(await tokens().countDocuments({ _id: bob.deviceId })).toBe(0);
  });

  it('needs a device-bound session and a valid body', async () => {
    const noDevice = await registeredUser(server);
    expect(json(await putToken(noDevice, 'token-x'))).toMatchObject({ code: 'DEVICE_REQUIRED' });

    const bob = await deviceSession(server, crypto);
    const insecure = await server.app.inject({
      method: 'PUT',
      url: '/v1/push/token',
      headers: bearer(bob.accessToken),
      payload: {
        provider: 'webpush',
        subscription: { endpoint: 'http://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } },
      },
    });
    expect(json(insecure)).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('moves a token to the device that registered it last', async () => {
    const old = await deviceSession(server, crypto);
    const reinstalled = await deviceSession(server, crypto);
    await putToken(old, 'shared-token');
    await putToken(reinstalled, 'shared-token');
    expect(await tokens().countDocuments({ _id: old.deviceId })).toBe(0);
    expect(await tokens().countDocuments({ _id: reinstalled.deviceId })).toBe(1);
  });

  it('deletes the token of a revoked device', async () => {
    const bob = await deviceSession(server, crypto);
    await putToken(bob, 'token-revoked');
    const revoked = await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${bob.deviceId}`,
      headers: bearer(bob.accessToken),
    });
    expect(revoked.statusCode).toBe(204);
    await vi.waitFor(async () =>
      expect(await tokens().countDocuments({ _id: bob.deviceId })).toBe(0),
    );
  });
});

describe('push wakes', () => {
  it('wakes an offline recipient with a content-free FCM message', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    await putToken(bob, 'token-bob');
    const socket = await TestSocket.connect(server, alice);
    const before = fcmBodies.length;

    const { messageId, envelopeId } = await sendStored(socket, alice, bob);
    await vi.waitFor(() => expect(fcmBodies.length).toBe(before + 1));
    const body = fcmBodies[before] ?? '';
    expect(JSON.parse(body)).toEqual({
      message: {
        token: 'token-bob',
        data: { t: 'wake' },
        android: { priority: 'HIGH', collapse_key: 'wake', ttl: '3600s' },
      },
    });
    for (const secret of [
      'PLAINTEXT-MARKER',
      messageId,
      envelopeId,
      alice.userId,
      alice.deviceId,
      bob.deviceId,
    ]) {
      expect(body).not.toContain(secret);
    }

    // A burst inside the throttle window collapses into one more wake at its end.
    await sendStored(socket, alice, bob);
    await sendStored(socket, alice, bob);
    await vi.waitFor(() => expect(fcmBodies.length).toBe(before + 2), { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fcmBodies.length).toBe(before + 2);
    socket.close();
  });

  it('does not wake a device without a token, and deletes a token FCM rejects', async () => {
    const alice = await deviceSession(server, crypto);
    const silent = await deviceSession(server, crypto);
    const gone = await deviceSession(server, crypto);
    deadTokens.add('token-dead');
    await putToken(gone, 'token-dead');
    const socket = await TestSocket.connect(server, alice);
    const before = fcmBodies.length;

    await sendStored(socket, alice, silent);
    await sendStored(socket, alice, gone);
    await vi.waitFor(async () =>
      expect(await tokens().countDocuments({ _id: gone.deviceId })).toBe(0),
    );
    expect(fcmBodies.length).toBe(before + 1);
    socket.close();
  });
});
