/**
 * Real device keys for integration tests: the WASM `CryptoProvider` (vodozemac) makes Olm
 * accounts and the account identity key, and `@pingdost/protocol` builds the signed bytes,
 * exactly as the apps will.
 */
import {
  createWasmCryptoProvider,
  type CryptoProvider,
  type OlmAccount,
  type SigningKey,
} from '@pingdost/crypto';
import {
  deviceCertificateMessage,
  deviceRegistrationMessage,
  signedKeyMessage,
  uuidv7,
} from '@pingdost/protocol';
import type {
  IdentityKeys,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  SignedKey,
} from '@pingdost/shared-types';

import { bearer, json, type TestServer } from './helpers';

let provider: Promise<CryptoProvider> | undefined;

export function cryptoProvider(): Promise<CryptoProvider> {
  provider ??= createWasmCryptoProvider();
  return provider;
}

export interface TestDevice {
  deviceId: string;
  account: OlmAccount;
  keys: IdentityKeys;
}

export function newDevice(crypto: CryptoProvider): TestDevice {
  const account = crypto.createAccount();
  return { deviceId: uuidv7(), account, keys: account.identityKeys() };
}

export function registrationBody(
  device: TestDevice,
  identity: SigningKey,
  nonce: string,
  overrides: Partial<RegisterDeviceRequest> = {},
): RegisterDeviceRequest {
  return {
    deviceId: device.deviceId,
    platform: 'android',
    name: 'Test phone',
    identityKeys: device.keys,
    nonce,
    signature: device.account.sign(deviceRegistrationMessage(nonce, device.deviceId, device.keys)),
    deviceCertificate: identity.sign(deviceCertificateMessage(device.deviceId, device.keys)),
    accountIdentityKey: identity.publicKey(),
    ...overrides,
  };
}

export async function challenge(server: TestServer, accessToken: string): Promise<string> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/devices/challenge',
    headers: bearer(accessToken),
  });
  if (response.statusCode !== 200) throw new Error(`challenge failed: ${response.body}`);
  return json<{ nonce: string }>(response).nonce;
}

/** Registers `device` on the session; returns the device-bound token pair. */
export async function registerDevice(
  server: TestServer,
  accessToken: string,
  device: TestDevice,
  identity: SigningKey,
): Promise<RegisterDeviceResponse> {
  const nonce = await challenge(server, accessToken);
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: bearer(accessToken),
    payload: registrationBody(device, identity, nonce),
  });
  if (response.statusCode !== 201) throw new Error(`device registration failed: ${response.body}`);
  return json<RegisterDeviceResponse>(response);
}

export function signedOneTimeKeys(device: TestDevice, count: number): SignedKey[] {
  device.account.generateOneTimeKeys(count);
  const keys = device.account.oneTimeKeys();
  device.account.markKeysAsPublished();
  return keys.map(({ keyId, publicKey }) => ({
    keyId,
    publicKey,
    signature: device.account.sign(signedKeyMessage('one_time', device.deviceId, keyId, publicKey)),
  }));
}

export function signedFallbackKey(device: TestDevice): SignedKey {
  device.account.generateFallbackKey();
  const key = device.account.fallbackKey();
  if (!key) throw new Error('no fallback key');
  return {
    ...key,
    signature: device.account.sign(
      signedKeyMessage('fallback', device.deviceId, key.keyId, key.publicKey),
    ),
  };
}
