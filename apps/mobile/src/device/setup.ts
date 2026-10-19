// Device setup after sign-in (ADR 0008, ADR 0009): pick or reuse this phone's device ID,
// load or create the account identity key, prove possession of the Olm keys with a fresh
// server nonce, register as the primary device (or resume it after a re-login), store the
// device-bound tokens, then publish keys. Framework-free so it is unit-tested in Node.
import { errorCode } from '@/api/errors';
import type { CryptoProvider, OlmAccount, SigningKey } from '@pingdost/crypto/core';
import { uuidv7 } from '@pingdost/protocol/ids';
import { deviceCertificateMessage, deviceRegistrationMessage } from '@pingdost/protocol/signing';
import type {
  AuthTokens,
  DeviceChallengeResponse,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  UserKeysResponse,
} from '@pingdost/shared-types';

import { syncKeys, type PublishKeysDeps, type PublishKeysResult } from './keys';

/** The device this phone registered, and the account it belongs to. */
export interface LocalDevice {
  deviceId: string;
  userId: string;
}

/**
 * - `primary_exists`: another phone holds the account (or its identity key is lost); moving
 *   the account is the recovery flow (Phase 19);
 * - `other_account`: this phone is set up for a different account;
 * - `username_required`: a Google account must pick a username first.
 */
export type DeviceSetupProblem = 'primary_exists' | 'other_account' | 'username_required';

export class DeviceSetupError extends Error {
  constructor(readonly problem: DeviceSetupProblem) {
    super(`device setup stopped: ${problem}`);
    this.name = 'DeviceSetupError';
  }
}

export interface DeviceSetupDeps {
  userId: string;
  platform: RegisterDeviceRequest['platform'];
  deviceName: string;
  provider: Pick<CryptoProvider, 'createSigningKey' | 'restoreSigningKey'>;
  crypto: {
    account(): OlmAccount;
    saveAccount(): Promise<void>;
    /** Replaces the Olm account with a new one (after this device was revoked). */
    resetAccount(): Promise<void>;
  };
  localDevice: {
    load(): Promise<LocalDevice | null>;
    save(device: LocalDevice): Promise<void>;
  };
  /** The account identity key secret (`SigningKey.exportSecret()`), in secure storage only. */
  identityKey: {
    load(): Promise<string | null>;
    save(secret: string): Promise<void>;
  };
  api: {
    me(): Promise<{ accountIdentityKey: string | null }>;
    challenge(): Promise<DeviceChallengeResponse>;
    register(body: RegisterDeviceRequest): Promise<RegisterDeviceResponse>;
    directory(userId: string): Promise<UserKeysResponse>;
    keys: PublishKeysDeps['keys'];
  };
  /** Persists the device-bound token pair; later requests must use it. */
  bindDevice(deviceId: string, tokens: AuthTokens): Promise<void>;
}

export interface DeviceSetupResult {
  deviceId: string;
  keys: PublishKeysResult;
}

const MAX_ATTEMPTS = 3;

async function loadIdentityKey(deps: DeviceSetupDeps): Promise<SigningKey> {
  const secret = await deps.identityKey.load();
  if (secret) return deps.provider.restoreSigningKey(secret);
  // The account already has an identity key, but not on this phone: it cannot certify
  // itself. Replacing the primary phone is the recovery flow (Phase 19).
  const { accountIdentityKey } = await deps.api.me();
  if (accountIdentityKey) throw new DeviceSetupError('primary_exists');
  const key = deps.provider.createSigningKey();
  // Stored before registration, so a retry certifies with the same key.
  await deps.identityKey.save(key.exportSecret());
  return key;
}

async function register(
  deps: DeviceSetupDeps,
  initial: LocalDevice,
  identity: SigningKey,
): Promise<LocalDevice> {
  let device = initial;
  for (let attempt = 1; ; attempt++) {
    const account = deps.crypto.account();
    const keys = account.identityKeys();
    const { nonce } = await deps.api.challenge();
    try {
      const { tokens } = await deps.api.register({
        deviceId: device.deviceId,
        platform: deps.platform,
        name: deps.deviceName,
        identityKeys: keys,
        nonce,
        signature: account.sign(deviceRegistrationMessage(nonce, device.deviceId, keys)),
        deviceCertificate: identity.sign(deviceCertificateMessage(device.deviceId, keys)),
        accountIdentityKey: identity.publicKey(),
      });
      await deps.bindDevice(device.deviceId, tokens);
      return device;
    } catch (error) {
      const code = errorCode(error);
      const again = attempt < MAX_ATTEMPTS;
      if (again && code === 'CHALLENGE_EXPIRED') continue;
      if (again && code === 'DEVICE_REVOKED') {
        // This phone's old device identity was revoked: start over with a new one.
        await deps.crypto.resetAccount();
        device = { deviceId: uuidv7(), userId: deps.userId };
        await deps.localDevice.save(device);
        continue;
      }
      if (code === 'PRIMARY_EXISTS' || code === 'IDENTITY_KEY_MISMATCH') {
        throw new DeviceSetupError('primary_exists');
      }
      if (code === 'USERNAME_REQUIRED') throw new DeviceSetupError('username_required');
      throw error;
    }
  }
}

export async function setUpDevice(deps: DeviceSetupDeps): Promise<DeviceSetupResult> {
  let device = await deps.localDevice.load();
  if (device && device.userId !== deps.userId) throw new DeviceSetupError('other_account');

  // Before the phone is claimed: an account that lives on another phone must not leave a
  // device record that would turn every other account away.
  const identity = await loadIdentityKey(deps);
  try {
    if (!device) {
      // Saved before registering, so a retry after a failure reuses the same device ID.
      device = { deviceId: uuidv7(), userId: deps.userId };
      await deps.localDevice.save(device);
    }
    device = await register(deps, device, identity);
  } finally {
    identity.dispose();
  }

  const keys = await syncKeys({
    userId: deps.userId,
    deviceId: device.deviceId,
    account: deps.crypto.account(),
    saveAccount: () => deps.crypto.saveAccount(),
    directory: (userId) => deps.api.directory(userId),
    keys: deps.api.keys,
  });
  return { deviceId: device.deviceId, keys };
}
