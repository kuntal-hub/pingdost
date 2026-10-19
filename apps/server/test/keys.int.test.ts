/** The public key directory: signed uploads, directory reads and atomic one-time-key claims. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { deviceCertificateMessage, signedKeyMessage, uuidv7 } from '@pingdost/protocol';
import type { ClaimKeysResponse, UserKeysResponse } from '@pingdost/shared-types';

import {
  cryptoProvider,
  newDevice,
  registerDevice,
  signedFallbackKey,
  signedOneTimeKeys,
  type TestDevice,
} from './devices';
import { bearer, json, registeredUser, startTestServer, type TestServer } from './helpers';

let server: TestServer;
let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    throttles: { keyClaims: { limit: 1_000, windowMs: 3_600_000 } },
  });
});

afterAll(async () => {
  await server.close();
});

/** A user with a registered primary device; returns its device-bound access token. */
async function userWithDevice(target = server) {
  const session = await registeredUser(target);
  const device = newDevice(crypto);
  const identity = crypto.createSigningKey();
  const { tokens } = await registerDevice(target, session.accessToken, device, identity);
  return { ...session, device, identity, accessToken: tokens.accessToken };
}

function upload(accessToken: string, payload: object, target = server) {
  return target.app.inject({
    method: 'POST',
    url: '/v1/keys/otks',
    headers: bearer(accessToken),
    payload,
  });
}

function claim(accessToken: string, deviceIds: string[], target = server) {
  return target.app.inject({
    method: 'POST',
    url: '/v1/keys/claim',
    headers: bearer(accessToken),
    payload: { deviceIds },
  });
}

function isSignedBy(
  device: TestDevice,
  kind: 'one_time' | 'fallback',
  key: { keyId: string; publicKey: string; signature: string },
) {
  return crypto.verifyEd25519(
    device.keys.ed25519,
    signedKeyMessage(kind, device.deviceId, key.keyId, key.publicKey),
    key.signature,
  );
}

describe('uploads', () => {
  it('stores signed one-time keys and the fallback key, idempotently', async () => {
    const owner = await userWithDevice();
    const keys = signedOneTimeKeys(owner.device, 10);
    const first = await upload(owner.accessToken, {
      oneTimeKeys: keys,
      fallbackKey: signedFallbackKey(owner.device),
    });
    expect(json(first)).toEqual({ count: 10 });
    expect(json(await upload(owner.accessToken, { oneTimeKeys: keys.slice(0, 4) }))).toEqual({
      count: 10,
    });
    const count = await server.app.inject({
      method: 'GET',
      url: '/v1/keys/otks/count',
      headers: bearer(owner.accessToken),
    });
    expect(json(count)).toEqual({ count: 10 });
  });

  it('rejects a batch with any bad signature and stores none of it', async () => {
    const owner = await userWithDevice();
    const keys = signedOneTimeKeys(owner.device, 3);
    const tampered = [...keys.slice(0, 2), { ...keys[2]!, publicKey: keys[0]!.publicKey }];
    expect(json(await upload(owner.accessToken, { oneTimeKeys: tampered }))).toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
    // A key signed by another device is rejected too.
    const foreign = signedOneTimeKeys(newDevice(crypto), 1);
    expect(json(await upload(owner.accessToken, { oneTimeKeys: foreign }))).toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
    expect(
      await server.mongo.db
        .collection('one_time_keys')
        .countDocuments({ deviceId: owner.device.deviceId }),
    ).toBe(0);
  });

  it('needs a device-bound session', async () => {
    const session = await registeredUser(server);
    expect(json(await upload(session.accessToken, { oneTimeKeys: [] }))).toMatchObject({
      code: 'DEVICE_REQUIRED',
    });
  });
});

describe('directory', () => {
  it('lists active devices with keys clients can verify', async () => {
    const owner = await userWithDevice();
    await upload(owner.accessToken, {
      oneTimeKeys: [],
      fallbackKey: signedFallbackKey(owner.device),
    });
    const reader = await registeredUser(server);
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/keys/users/${owner.userId}`,
      headers: bearer(reader.accessToken),
    });
    const directory = json<UserKeysResponse>(response);
    expect(directory.accountIdentityKey).toBe(owner.identity.publicKey());
    expect(directory.keyVersion).toBe(1);
    const [entry] = directory.devices;
    expect(entry?.deviceId).toBe(owner.device.deviceId);
    // The client-side checks a sender makes before encrypting to the device:
    expect(
      crypto.verifyEd25519(
        directory.accountIdentityKey ?? '',
        deviceCertificateMessage(entry!.deviceId, entry!.identityKeys),
        entry!.deviceCertificate,
      ),
    ).toBe(true);
    expect(isSignedBy(owner.device, 'fallback', entry!.fallbackKey!)).toBe(true);
  });

  it('answers NOT_FOUND for unknown users', async () => {
    const reader = await registeredUser(server);
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/keys/users/${uuidv7()}`,
      headers: bearer(reader.accessToken),
    });
    expect(json(response)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('names the owner of an active device, and nothing for revoked ones', async () => {
    const owner = await userWithDevice();
    const reader = await registeredUser(server);
    const lookup = () =>
      server.app.inject({
        method: 'GET',
        url: `/v1/keys/devices/${owner.device.deviceId}`,
        headers: bearer(reader.accessToken),
      });
    expect(json(await lookup())).toEqual({
      deviceId: owner.device.deviceId,
      userId: owner.userId,
    });
    await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${owner.device.deviceId}`,
      headers: bearer(owner.accessToken),
    });
    expect(json(await lookup())).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('claims', () => {
  it('never hands out a one-time key twice under 50 parallel claims, then falls back', async () => {
    const owner = await userWithDevice();
    const published = signedOneTimeKeys(owner.device, 20);
    await upload(owner.accessToken, {
      oneTimeKeys: published,
      fallbackKey: signedFallbackKey(owner.device),
    });
    const claimer = await userWithDevice();

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => claim(claimer.accessToken, [owner.device.deviceId])),
    );
    const keys = responses.map((response) => {
      expect(response.statusCode).toBe(200);
      const [key] = json<ClaimKeysResponse>(response).keys;
      expect(key).toBeDefined();
      return key!;
    });
    const oneTime = keys.filter((key) => !key.fallback);
    expect(oneTime).toHaveLength(20);
    expect(new Set(oneTime.map((key) => key.key.keyId)).size).toBe(20);
    expect(oneTime.map((key) => key.key.keyId).sort()).toEqual(
      published.map((key) => key.keyId).sort(),
    );
    expect(keys.filter((key) => key.fallback)).toHaveLength(30);
    for (const key of keys) {
      expect(isSignedBy(owner.device, key.fallback ? 'fallback' : 'one_time', key.key)).toBe(true);
    }
    expect(
      await server.mongo.db
        .collection('one_time_keys')
        .countDocuments({ deviceId: owner.device.deviceId }),
    ).toBe(0);
  });

  it('opens a working Olm session with a claimed key', async () => {
    const owner = await userWithDevice();
    await upload(owner.accessToken, { oneTimeKeys: signedOneTimeKeys(owner.device, 1) });
    const claimer = await userWithDevice();
    const [claimed] = json<ClaimKeysResponse>(
      await claim(claimer.accessToken, [owner.device.deviceId]),
    ).keys;

    const outbound = claimer.device.account.createOutboundSession(
      owner.device.keys.curve25519,
      claimed!.key.publicKey,
    );
    const message = outbound.encrypt(new TextEncoder().encode('hi'));
    const { plaintext } = owner.device.account.createInboundSession(
      claimer.device.keys.curve25519,
      message,
    );
    expect(new TextDecoder().decode(plaintext)).toBe('hi');
  });

  it('leaves out unknown and revoked devices', async () => {
    const owner = await userWithDevice();
    await upload(owner.accessToken, { oneTimeKeys: signedOneTimeKeys(owner.device, 2) });
    const claimer = await userWithDevice();
    await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${owner.device.deviceId}`,
      headers: bearer(owner.accessToken),
    });
    const response = await claim(claimer.accessToken, [owner.device.deviceId, uuidv7()]);
    expect(json(response)).toEqual({ keys: [] });
  });

  it('limits claims per account', async () => {
    const limited = await startTestServer({
      throttles: { keyClaims: { limit: 3, windowMs: 3_600_000 } },
    });
    try {
      const owner = await userWithDevice(limited);
      await upload(
        owner.accessToken,
        { oneTimeKeys: [], fallbackKey: signedFallbackKey(owner.device) },
        limited,
      );
      const claimer = await userWithDevice(limited);
      for (let i = 0; i < 3; i++) {
        expect(
          (await claim(claimer.accessToken, [owner.device.deviceId], limited)).statusCode,
        ).toBe(200);
      }
      const over = await claim(claimer.accessToken, [owner.device.deviceId], limited);
      expect(over.statusCode).toBe(429);
      expect(json(over)).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await limited.close();
    }
  });
});
