/** Device registration (proof of possession + device certificate) and revocation. */
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { uuidv7 } from '@pingdost/protocol';
import type { RegisterDeviceRequest } from '@pingdost/shared-types';

import {
  challenge,
  cryptoProvider,
  newDevice,
  registerDevice,
  registrationBody,
  signedFallbackKey,
  signedOneTimeKeys,
} from './devices';
import { bearer, json, registeredUser, startTestServer, type TestServer } from './helpers';

let server: TestServer;
let crypto: CryptoProvider;
const revokedHook: string[] = [];

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({ onDeviceRevoked: [(deviceId) => revokedHook.push(deviceId)] });
});

afterAll(async () => {
  await server.close();
});

function register(accessToken: string, payload: object) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: bearer(accessToken),
    payload,
  });
}

function me(accessToken: string) {
  return server.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(accessToken) });
}

async function login(username: string, password: string): Promise<string> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { identifier: username, password },
  });
  return json<{ tokens: { accessToken: string } }>(response).tokens.accessToken;
}

describe('device registration', () => {
  it('registers the primary device, binds the session and stores public keys only', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const device = newDevice(crypto);

    const registered = await registerDevice(server, session.accessToken, device, identity);
    expect(registered.device).toMatchObject({
      deviceId: device.deviceId,
      platform: 'android',
      role: 'primary',
      status: 'active',
      revokedAt: null,
    });
    expect(registered.device.lastSeenAt).toBeGreaterThan(0);
    expect(decodeJwt(registered.tokens.accessToken)).toMatchObject({ did: device.deviceId });
    expect((await me(registered.tokens.accessToken)).statusCode).toBe(200);
    expect(json(await me(registered.tokens.accessToken))).toMatchObject({
      accountIdentityKey: identity.publicKey(),
    });

    // The pre-binding refresh token was rotated out: presenting it now is reuse.
    const stale = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(json(stale)).toMatchObject({ code: 'TOKEN_REUSED' });
  });

  it('keeps private keys off the server', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const device = newDevice(crypto);
    const { tokens } = await registerDevice(server, session.accessToken, device, identity);
    await server.app.inject({
      method: 'POST',
      url: '/v1/keys/otks',
      headers: bearer(tokens.accessToken),
      payload: {
        oneTimeKeys: signedOneTimeKeys(device, 5),
        fallbackKey: signedFallbackKey(device),
      },
    });

    const stored = JSON.stringify([
      await server.mongo.db.collection('users').findOne({ _id: session.userId as never }),
      await server.mongo.db.collection('devices').findOne({ _id: device.deviceId as never }),
      await server.mongo.db
        .collection('one_time_keys')
        .find({ deviceId: device.deviceId })
        .toArray(),
    ]);
    // Public keys are there; the account identity secret and any private key are not.
    expect(stored).toContain(device.keys.ed25519);
    expect(stored).toContain(identity.publicKey());
    expect(stored).not.toContain(identity.exportSecret());
    expect(stored).not.toMatch(/secret|private|pickle/i);
  });

  it('rejects a bad proof of possession and consumes the nonce', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const device = newDevice(crypto);
    const nonce = await challenge(server, session.accessToken);
    const forged = registrationBody(device, identity, nonce, {
      signature: newDevice(crypto).account.sign(new Uint8Array([1, 2, 3])),
    });
    expect(json(await register(session.accessToken, forged))).toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
    // The nonce is single-use, even after a failed attempt.
    const retry = registrationBody(device, identity, nonce);
    expect(json(await register(session.accessToken, retry))).toMatchObject({
      code: 'CHALLENGE_EXPIRED',
    });
  });

  it('rejects expired and foreign nonces', async () => {
    const session = await registeredUser(server);
    const other = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const device = newDevice(crypto);

    const foreign = await challenge(server, other.accessToken);
    expect(
      json(await register(session.accessToken, registrationBody(device, identity, foreign))),
    ).toMatchObject({ code: 'CHALLENGE_EXPIRED' });

    const nonce = await challenge(server, session.accessToken);
    server.clock.advance(5 * 60_000 + 1);
    expect(
      json(await register(session.accessToken, registrationBody(device, identity, nonce))),
    ).toMatchObject({ code: 'CHALLENGE_EXPIRED' });
  });

  it('rejects a certificate not signed by the account identity key', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const impostor = crypto.createSigningKey();
    const device = newDevice(crypto);
    const nonce = await challenge(server, session.accessToken);
    const body = registrationBody(device, identity, nonce, {
      deviceCertificate: registrationBody(device, impostor, nonce).deviceCertificate,
    });
    expect(json(await register(session.accessToken, body))).toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
  });

  it('needs the account identity key from the first device', async () => {
    const session = await registeredUser(server);
    const device = newDevice(crypto);
    const nonce = await challenge(server, session.accessToken);
    const body: Partial<RegisterDeviceRequest> = registrationBody(
      device,
      crypto.createSigningKey(),
      nonce,
    );
    delete body.accountIdentityKey;
    expect(json(await register(session.accessToken, body))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('allows one active primary and one account identity key', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    await registerDevice(server, session.accessToken, newDevice(crypto), identity);

    const second = await login(session.user.username, session.user.password);
    const nonce = await challenge(server, second);
    expect(
      json(await register(second, registrationBody(newDevice(crypto), identity, nonce))),
    ).toMatchObject({ code: 'PRIMARY_EXISTS' });

    const otherNonce = await challenge(server, second);
    expect(
      json(
        await register(
          second,
          registrationBody(newDevice(crypto), crypto.createSigningKey(), otherNonce),
        ),
      ),
    ).toMatchObject({ code: 'IDENTITY_KEY_MISMATCH' });
  });

  it('resumes the same device on a new session, with no second primary', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const device = newDevice(crypto);
    const first = await registerDevice(server, session.accessToken, device, identity);
    const users = server.mongo.db.collection<{ keyVersion: number }>('users');
    const keyVersion = (await users.findOne({ _id: session.userId as never }))?.keyVersion;

    const relogin = await login(session.user.username, session.user.password);
    const resumed = await registerDevice(server, relogin, device, identity);
    expect(resumed.device).toEqual(first.device);
    expect(decodeJwt(resumed.tokens.accessToken)).toMatchObject({ did: device.deviceId });
    expect(
      await server.mongo.db.collection('devices').countDocuments({ userId: session.userId }),
    ).toBe(1);
    expect((await users.findOne({ _id: session.userId as never }))?.keyVersion).toBe(keyVersion);
    expect(
      await server.mongo.db
        .collection('security_events')
        .countDocuments({ userId: session.userId, type: 'device_resume' }),
    ).toBe(1);

    // Another account, or other keys under the same device ID, cannot take the device over.
    const stranger = await registeredUser(server);
    const strangerNonce = await challenge(server, stranger.accessToken);
    expect(
      json(
        await register(
          stranger.accessToken,
          registrationBody(device, crypto.createSigningKey(), strangerNonce),
        ),
      ),
    ).toMatchObject({ code: 'CONFLICT' });
    const impostor = { ...newDevice(crypto), deviceId: device.deviceId };
    const otherKeys = await login(session.user.username, session.user.password);
    const otherNonce = await challenge(server, otherKeys);
    expect(
      json(await register(otherKeys, registrationBody(impostor, identity, otherNonce))),
    ).toMatchObject({ code: 'CONFLICT' });

    // A revoked device stays revoked.
    await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${device.deviceId}`,
      headers: bearer(resumed.tokens.accessToken),
    });
    const afterRevoke = await login(session.user.username, session.user.password);
    const revokedNonce = await challenge(server, afterRevoke);
    expect(
      json(await register(afterRevoke, registrationBody(device, identity, revokedNonce))),
    ).toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('refuses web devices, bound sessions and accounts without a username', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const nonce = await challenge(server, session.accessToken);
    const web = registrationBody(newDevice(crypto), identity, nonce, { platform: 'web' as never });
    expect((await register(session.accessToken, web)).statusCode).toBe(400);

    const { tokens } = await registerDevice(
      server,
      session.accessToken,
      newDevice(crypto),
      identity,
    );
    const again = await challenge(server, tokens.accessToken);
    expect(
      json(
        await register(tokens.accessToken, registrationBody(newDevice(crypto), identity, again)),
      ),
    ).toMatchObject({ code: 'CONFLICT' });

    const pending = await registeredUser(server);
    await server.mongo.db
      .collection('users')
      .updateOne(
        { _id: pending.userId as never },
        { $set: { status: 'pending_username', username: null } },
      );
    const pendingNonce = await challenge(server, pending.accessToken);
    expect(
      json(
        await register(
          pending.accessToken,
          registrationBody(newDevice(crypto), crypto.createSigningKey(), pendingNonce),
        ),
      ),
    ).toMatchObject({ code: 'USERNAME_REQUIRED' });
  });
});

describe('device list and revocation', () => {
  it('revokes a device: sessions, keys, keyVersion, audit and the hook', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const device = newDevice(crypto);
    const { tokens } = await registerDevice(server, session.accessToken, device, identity);
    await server.app.inject({
      method: 'POST',
      url: '/v1/keys/otks',
      headers: bearer(tokens.accessToken),
      payload: { oneTimeKeys: signedOneTimeKeys(device, 3) },
    });
    const listed = await server.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(tokens.accessToken),
    });
    expect(
      json<{ devices: { deviceId: string }[] }>(listed).devices.map((d) => d.deviceId),
    ).toEqual([device.deviceId]);
    const before = await server.mongo.db
      .collection('users')
      .findOne({ _id: session.userId as never });

    const revoked = await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${device.deviceId}`,
      headers: bearer(tokens.accessToken),
    });
    expect(revoked.statusCode).toBe(204);

    expect(json(await me(tokens.accessToken))).toMatchObject({ code: 'UNAUTHENTICATED' });
    const db = server.mongo.db;
    expect(await db.collection('one_time_keys').countDocuments({ deviceId: device.deviceId })).toBe(
      0,
    );
    expect(await db.collection('devices').findOne({ _id: device.deviceId as never })).toMatchObject(
      {
        status: 'revoked',
        fallbackKey: null,
      },
    );
    const after = await db.collection('users').findOne({ _id: session.userId as never });
    expect(after?.keyVersion).toBe((before?.keyVersion as number) + 1);
    expect(
      await db
        .collection('security_events')
        .countDocuments({ type: 'device_revoke', userId: session.userId }),
    ).toBe(1);
    expect(revokedHook).toContain(device.deviceId);

    // With the primary gone, a new phone (certified by the same identity key) can register.
    const fresh = await login(session.user.username, session.user.password);
    await expect(registerDevice(server, fresh, newDevice(crypto), identity)).resolves.toBeDefined();
  });

  it('lets the primary revoke linked devices, but not unbound sessions or strangers', async () => {
    const session = await registeredUser(server);
    const identity = crypto.createSigningKey();
    const { tokens } = await registerDevice(
      server,
      session.accessToken,
      newDevice(crypto),
      identity,
    );
    // Linked (web) devices arrive through pairing in Phase 16; insert one directly.
    const linkedId = uuidv7();
    const web = newDevice(crypto);
    await server.mongo.db.collection('devices').insertOne({
      _id: linkedId as never,
      userId: session.userId,
      platform: 'web',
      role: 'linked',
      name: 'Browser',
      identityKeys: web.keys,
      deviceCertificate: 'x',
      fallbackKey: null,
      keyVersion: 1,
      status: 'active',
      createdAt: new Date(),
      revokedAt: null,
      lastSeenAt: null,
    });

    const unbound = await login(session.user.username, session.user.password);
    const fromUnbound = await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${linkedId}`,
      headers: bearer(unbound),
    });
    expect(json(fromUnbound)).toMatchObject({ code: 'DEVICE_REQUIRED' });

    const stranger = await registeredUser(server);
    const strangerTokens = await registerDevice(
      server,
      stranger.accessToken,
      newDevice(crypto),
      crypto.createSigningKey(),
    );
    const fromStranger = await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${linkedId}`,
      headers: bearer(strangerTokens.tokens.accessToken),
    });
    expect(json(fromStranger)).toMatchObject({ code: 'DEVICE_NOT_FOUND' });

    const byPrimary = await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${linkedId}`,
      headers: bearer(tokens.accessToken),
    });
    expect(byPrimary.statusCode).toBe(204);
    // Idempotent.
    const again = await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${linkedId}`,
      headers: bearer(tokens.accessToken),
    });
    expect(again.statusCode).toBe(204);
    expect((await me(tokens.accessToken)).statusCode).toBe(200);
  });
});
