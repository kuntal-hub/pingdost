// Device setup against an in-memory server that checks every signature like the real one,
// with the real vodozemac WASM provider (the phone uses the native build of the same crate).
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@pingdost/api-client';
import { createWasmCryptoProvider, type CryptoProvider, type OlmAccount } from '@pingdost/crypto';
import { toBase64Url } from '@pingdost/protocol/ids';
import {
  deviceCertificateMessage,
  deviceRegistrationMessage,
  signedKeyMessage,
} from '@pingdost/protocol/signing';
import type {
  ErrorCode,
  RegisterDeviceRequest,
  SignedKey,
  UploadKeysRequest,
} from '@pingdost/shared-types';

import { ONE_TIME_KEY_TARGET, publishKeys } from './keys';
import { DeviceSetupError, setUpDevice, type DeviceSetupDeps, type LocalDevice } from './setup';

const USER_ID = '01920000-0000-7000-8000-0000000000a1';
const OTHER_USER_ID = '01920000-0000-7000-8000-0000000000b2';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

const fail = (status: number, code: ErrorCode) =>
  new ApiError('http', `request failed: ${status} ${code}`, { status, code });

interface ServerDevice {
  body: RegisterDeviceRequest;
  status: 'active' | 'revoked';
  fallbackKey: SignedKey | null;
}

/** The parts of the server that device setup talks to, checking what the server checks. */
function fakeServer() {
  const nonces = new Set<string>();
  const devices = new Map<string, ServerDevice>();
  const oneTimeKeys = new Map<string, Map<string, SignedKey>>();
  let accountIdentityKey: string | null = null;
  let currentDevice: string | null = null;
  let tokenSerial = 0;

  const verify = (key: string, message: Uint8Array, signature: string) =>
    provider.verifyEd25519(key, message, signature);

  const api: DeviceSetupDeps['api'] = {
    me: () => Promise.resolve({ accountIdentityKey }),
    challenge: () => {
      const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      nonces.add(nonce);
      return Promise.resolve({ nonce, expiresAt: Date.now() + 300_000 });
    },
    register: (body) => {
      if (!nonces.delete(body.nonce)) return Promise.reject(fail(400, 'CHALLENGE_EXPIRED'));
      const keys = body.identityKeys;
      const proof = deviceRegistrationMessage(body.nonce, body.deviceId, keys);
      if (!verify(keys.ed25519, proof, body.signature)) {
        return Promise.reject(fail(400, 'INVALID_SIGNATURE'));
      }
      const accountKey = accountIdentityKey ?? body.accountIdentityKey;
      if (!accountKey || (body.accountIdentityKey && body.accountIdentityKey !== accountKey)) {
        return Promise.reject(fail(409, 'IDENTITY_KEY_MISMATCH'));
      }
      const certificate = deviceCertificateMessage(body.deviceId, keys);
      if (!verify(accountKey, certificate, body.deviceCertificate)) {
        return Promise.reject(fail(400, 'INVALID_SIGNATURE'));
      }
      const existing = devices.get(body.deviceId);
      if (existing) {
        if (existing.body.identityKeys.ed25519 !== keys.ed25519) {
          return Promise.reject(fail(409, 'CONFLICT'));
        }
        if (existing.status !== 'active') return Promise.reject(fail(401, 'DEVICE_REVOKED'));
      } else {
        const primary = [...devices.values()].some((device) => device.status === 'active');
        if (primary) return Promise.reject(fail(409, 'PRIMARY_EXISTS'));
        devices.set(body.deviceId, { body, status: 'active', fallbackKey: null });
      }
      accountIdentityKey = accountKey;
      currentDevice = body.deviceId;
      tokenSerial++;
      return Promise.resolve({
        device: {
          deviceId: body.deviceId,
          platform: body.platform,
          role: 'primary',
          name: body.name,
          status: 'active',
          createdAt: 1,
          lastSeenAt: 1,
          revokedAt: null,
        },
        tokens: {
          accessToken: `access-${tokenSerial}`,
          accessTokenExpiresAt: 1,
          refreshToken: `refresh-${tokenSerial}`,
          refreshTokenExpiresAt: 2,
        },
      });
    },
    directory: (userId) =>
      Promise.resolve({
        userId,
        accountIdentityKey,
        keyVersion: devices.size,
        devices: [...devices.entries()]
          .filter(([, device]) => device.status === 'active')
          .map(([deviceId, device]) => ({
            deviceId,
            platform: 'android' as const,
            role: 'primary' as const,
            identityKeys: device.body.identityKeys,
            deviceCertificate: device.body.deviceCertificate,
            fallbackKey: device.fallbackKey,
          })),
      }),
    keys: {
      count: () => Promise.resolve(oneTimeKeys.get(currentDevice ?? '')?.size ?? 0),
      upload: vi.fn((body: UploadKeysRequest) => {
        const deviceId = currentDevice;
        const device = deviceId ? devices.get(deviceId) : undefined;
        if (!deviceId || !device) return Promise.reject(fail(403, 'DEVICE_REQUIRED'));
        const ed25519 = device.body.identityKeys.ed25519;
        const signed = (kind: 'one_time' | 'fallback', key: SignedKey) =>
          verify(
            ed25519,
            signedKeyMessage(kind, deviceId, key.keyId, key.publicKey),
            key.signature,
          );
        if (
          !body.oneTimeKeys.every((key) => signed('one_time', key)) ||
          (body.fallbackKey && !signed('fallback', body.fallbackKey))
        ) {
          return Promise.reject(fail(400, 'INVALID_SIGNATURE'));
        }
        const stored = oneTimeKeys.get(deviceId) ?? new Map<string, SignedKey>();
        for (const key of body.oneTimeKeys) stored.set(key.keyId, key);
        oneTimeKeys.set(deviceId, stored);
        if (body.fallbackKey) device.fallbackKey = body.fallbackKey;
        return Promise.resolve(stored.size);
      }),
    },
  };

  return {
    api,
    devices,
    setAccountIdentityKey: (key: string) => (accountIdentityKey = key),
    revoke: (deviceId: string) => {
      const device = devices.get(deviceId);
      if (device) device.status = 'revoked';
      oneTimeKeys.delete(deviceId);
    },
    claim: (deviceId: string, count: number) => {
      const stored = oneTimeKeys.get(deviceId);
      for (const keyId of [...(stored?.keys() ?? [])].slice(0, count)) stored?.delete(keyId);
    },
  };
}

/** One phone: its Olm account, local settings and secure storage, kept across runs. */
function phone(server: ReturnType<typeof fakeServer>, userId = USER_ID) {
  let account: OlmAccount = provider.createAccount();
  let local: LocalDevice | null = null;
  let identitySecret: string | null = null;
  const bound: { deviceId: string; accessToken: string }[] = [];
  const saveAccount = vi.fn(() => Promise.resolve());

  const deps = (): DeviceSetupDeps => ({
    userId,
    platform: 'android',
    deviceName: 'Test phone',
    provider,
    crypto: {
      account: () => account,
      saveAccount,
      resetAccount: () => {
        account.dispose();
        account = provider.createAccount();
        return Promise.resolve();
      },
    },
    localDevice: {
      load: () => Promise.resolve(local),
      save: (device) => {
        local = device;
        return Promise.resolve();
      },
    },
    identityKey: {
      load: () => Promise.resolve(identitySecret),
      save: (secret) => {
        identitySecret = secret;
        return Promise.resolve();
      },
    },
    api: server.api,
    bindDevice: (deviceId, tokens) => {
      bound.push({ deviceId, accessToken: tokens.accessToken });
      return Promise.resolve();
    },
  });

  return {
    deps,
    bound,
    saveAccount,
    account: () => account,
    local: () => local,
    identitySecret: () => identitySecret,
    setLocal: (device: LocalDevice) => (local = device),
  };
}

describe('device setup', () => {
  it('registers the primary device and publishes signed keys', async () => {
    const server = fakeServer();
    const device = phone(server);

    const result = await setUpDevice(device.deps());

    expect(result.deviceId).toBe(device.local()?.deviceId);
    expect(device.bound).toEqual([{ deviceId: result.deviceId, accessToken: 'access-1' }]);
    expect(result.keys).toEqual({
      uploaded: ONE_TIME_KEY_TARGET,
      fallbackUploaded: true,
      serverCount: ONE_TIME_KEY_TARGET,
    });
    // The identity secret stays on the phone; the server only has the public key.
    const secret = device.identitySecret();
    expect(secret).toBeTruthy();
    const identity = provider.restoreSigningKey(secret ?? '');
    expect((await server.api.me()).accountIdentityKey).toBe(identity.publicKey());
    expect(JSON.stringify([...server.devices.values()])).not.toContain(secret);
    // Published keys are no longer pending, and the account was re-pickled after that.
    expect(device.account().oneTimeKeys()).toEqual([]);
    expect(device.account().fallbackKey()).toBeUndefined();
    expect(device.saveAccount).toHaveBeenCalled();
  });

  it('resumes the same device after a re-login without new keys', async () => {
    const server = fakeServer();
    const device = phone(server);
    const first = await setUpDevice(device.deps());

    const again = await setUpDevice(device.deps());
    expect(again.deviceId).toBe(first.deviceId);
    expect(server.devices.size).toBe(1);
    expect(device.bound.map((entry) => entry.accessToken)).toEqual(['access-1', 'access-2']);
    expect(again.keys).toEqual({
      uploaded: 0,
      fallbackUploaded: false,
      serverCount: ONE_TIME_KEY_TARGET,
    });
  });

  it('stops when the account lives on another phone or this phone has another account', async () => {
    const server = fakeServer();
    server.setAccountIdentityKey(provider.createSigningKey().publicKey());
    const newPhone = phone(server);
    await expect(setUpDevice(newPhone.deps())).rejects.toEqual(
      new DeviceSetupError('primary_exists'),
    );
    expect(newPhone.identitySecret()).toBeNull();
    // The phone is not claimed: another account can still set it up.
    expect(newPhone.local()).toBeNull();

    const shared = phone(fakeServer(), USER_ID);
    shared.setLocal({ deviceId: '01920000-0000-7000-8000-0000000000c3', userId: OTHER_USER_ID });
    await expect(setUpDevice(shared.deps())).rejects.toEqual(new DeviceSetupError('other_account'));
  });

  it('answers PRIMARY_EXISTS when another device of the account is active', async () => {
    const server = fakeServer();
    const first = phone(server);
    await setUpDevice(first.deps());

    // Same account and identity key, but a second device ID: the one-primary rule applies.
    const second = phone(server);
    await second.deps().identityKey.save(first.identitySecret() ?? '');
    await expect(setUpDevice(second.deps())).rejects.toEqual(
      new DeviceSetupError('primary_exists'),
    );
  });

  it('starts over with a new device identity after this device was revoked', async () => {
    const server = fakeServer();
    const device = phone(server);
    const first = await setUpDevice(device.deps());
    const oldKey = device.account().identityKeys().ed25519;
    server.revoke(first.deviceId);

    const next = await setUpDevice(device.deps());
    expect(next.deviceId).not.toBe(first.deviceId);
    expect(device.account().identityKeys().ed25519).not.toBe(oldKey);
    expect(next.keys).toMatchObject({ uploaded: ONE_TIME_KEY_TARGET, fallbackUploaded: true });
  });
});

describe('publishKeys', () => {
  it('tops up below the minimum and re-sends the same keys after a failed upload', async () => {
    const server = fakeServer();
    const device = phone(server);
    const { deviceId } = await setUpDevice(device.deps());
    const keysDeps = {
      account: device.account(),
      deviceId,
      keys: server.api.keys,
      saveAccount: device.saveAccount,
    };

    server.claim(deviceId, 25); // 25 left: enough
    expect(await publishKeys(keysDeps)).toMatchObject({ uploaded: 0, serverCount: 25 });

    server.claim(deviceId, 10); // 15 left: top up to the target
    const upload = vi.mocked(server.api.keys.upload);
    upload.mockRejectedValueOnce(new ApiError('network', 'no response', { code: 'UNAVAILABLE' }));
    await expect(publishKeys(keysDeps)).rejects.toThrow('no response');
    const pending = device
      .account()
      .oneTimeKeys()
      .map((key) => key.keyId);
    expect(pending).toHaveLength(ONE_TIME_KEY_TARGET - 15);

    const retried = await publishKeys(keysDeps);
    expect(retried).toMatchObject({ uploaded: pending.length, serverCount: ONE_TIME_KEY_TARGET });
    const lastBody = upload.mock.lastCall?.[0];
    expect(lastBody?.oneTimeKeys.map((key) => key.keyId)).toEqual(pending);
  });
});
