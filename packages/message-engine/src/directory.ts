/**
 * The key directory as the engine trusts it (ADR 0003, ADR 0008). A device is used only when
 * its certificate verifies against the user's account identity key; a fallback key is cached
 * only when the device's own ed25519 key signed it. The server can withhold or add devices,
 * but it cannot make the engine encrypt to a key the account did not certify; a substituted
 * account identity key shows up as a changed safety number.
 */
import type { CryptoProvider } from '@pingdost/crypto/core';
import { deviceCertificateMessage, signedKeyMessage } from '@pingdost/protocol/signing';
import type {
  ClaimKeysResponse,
  DeviceOwnerResponse,
  UserKeysResponse,
} from '@pingdost/shared-types';

import type { DirectoryDeviceRecord, DirectoryRecord } from './store';

/** The REST calls the engine needs (`keysApi` from `@pingdost/api-client` fits). */
export interface DirectoryApi {
  directory(userId: string): Promise<UserKeysResponse>;
  deviceOwner(deviceId: string): Promise<DeviceOwnerResponse>;
  claim(deviceIds: string[]): Promise<ClaimKeysResponse>;
}

/** A REST error carrying a shared `ErrorCode` (as `ApiError` does). */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Whether a failed call means "this does not exist", rather than "try again later". */
export function isNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'NOT_FOUND' || code === 'DEVICE_NOT_FOUND';
}

function signedBy(
  crypto: CryptoProvider,
  publicKey: string,
  message: () => Uint8Array,
  signature: string,
): boolean {
  try {
    return crypto.verifyEd25519(publicKey, message(), signature);
  } catch {
    return false; // malformed keys or IDs
  }
}

export interface VerifiedDirectory {
  record: Omit<DirectoryRecord, 'verifiedIdentityKey'>;
  /** Devices the directory listed whose certificate did not verify. */
  rejected: number;
}

/** Keeps only the devices the account identity key certified. */
export function verifyDirectory(
  crypto: CryptoProvider,
  response: UserKeysResponse,
  fetchedAt: number,
): VerifiedDirectory {
  const identityKey = response.accountIdentityKey;
  const devices: DirectoryDeviceRecord[] = [];
  let rejected = 0;
  for (const device of response.devices) {
    const certified =
      identityKey !== null &&
      signedBy(
        crypto,
        identityKey,
        () => deviceCertificateMessage(device.deviceId, device.identityKeys),
        device.deviceCertificate,
      );
    if (!certified) {
      rejected++;
      continue;
    }
    const fallback = device.fallbackKey;
    const fallbackSigned =
      fallback !== null &&
      signedBy(
        crypto,
        device.identityKeys.ed25519,
        () => signedKeyMessage('fallback', device.deviceId, fallback.keyId, fallback.publicKey),
        fallback.signature,
      );
    devices.push({
      deviceId: device.deviceId,
      platform: device.platform,
      role: device.role,
      curve25519: device.identityKeys.curve25519,
      ed25519: device.identityKeys.ed25519,
      fallbackKey: fallbackSigned ? fallback : null,
    });
  }
  return {
    record: {
      userId: response.userId,
      accountIdentityKey: identityKey,
      keyVersion: response.keyVersion,
      devices,
      fetchedAt,
    },
    rejected,
  };
}

export interface DirectoryChange {
  added: DirectoryDeviceRecord[];
  removed: DirectoryDeviceRecord[];
  /** The account identity key differs from the one cached before (not the first sighting). */
  identityChanged: boolean;
}

export function diffDirectory(
  previous: DirectoryRecord | undefined,
  next: Pick<DirectoryRecord, 'accountIdentityKey' | 'devices'>,
): DirectoryChange {
  const before = new Map((previous?.devices ?? []).map((d) => [d.deviceId, d]));
  const after = new Map(next.devices.map((d) => [d.deviceId, d]));
  // A device ID whose keys changed is a different device as far as sessions go.
  const same = (a: DirectoryDeviceRecord, b: DirectoryDeviceRecord) =>
    a.curve25519 === b.curve25519 && a.ed25519 === b.ed25519;
  return {
    added: next.devices.filter((d) => {
      const old = before.get(d.deviceId);
      return !old || !same(old, d);
    }),
    removed: (previous?.devices ?? []).filter((d) => {
      const now = after.get(d.deviceId);
      return !now || !same(now, d);
    }),
    identityChanged:
      previous?.accountIdentityKey != null &&
      next.accountIdentityKey !== previous.accountIdentityKey,
  };
}

/** Whether a claimed one-time or fallback key carries the device's own signature. */
export function claimedKeySigned(
  crypto: CryptoProvider,
  device: DirectoryDeviceRecord,
  claimed: ClaimKeysResponse['keys'][number],
): boolean {
  return signedBy(
    crypto,
    device.ed25519,
    () =>
      signedKeyMessage(
        claimed.fallback ? 'fallback' : 'one_time',
        device.deviceId,
        claimed.key.keyId,
        claimed.key.publicKey,
      ),
    claimed.key.signature,
  );
}
