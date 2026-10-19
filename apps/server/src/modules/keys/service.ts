/**
 * The public key directory (REQ §15, ADR 0003, ADR 0008): devices publish signed one-time keys
 * and a fallback key; peers claim one key per device atomically.
 */
import type { Collection } from 'mongodb';

import { ProtocolError, signedKeyMessage } from '@pingdost/protocol';
import type {
  ClaimKeysResponse,
  DeviceOwnerResponse,
  DirectoryDevice,
  SignedKey,
  UploadKeysRequest,
  UserKeysResponse,
} from '@pingdost/shared-types';

import type { OneTimeKeyDoc } from './repo';
import type { Clock } from '../../infra/clock';
import { WindowCounter } from '../../infra/counters';
import { verifyEd25519 } from '../../infra/ed25519';
import { AppError } from '../../infra/errors';
import type { Budget } from '../../infra/throttles';
import type { AuthContext } from '../auth/guard';
import type { AuthCollections } from '../auth/repo';
import type { DeviceCollections, DeviceDoc } from '../device/repo';

/** Unclaimed one-time keys a device may keep on the server. */
export const MAX_STORED_ONE_TIME_KEYS = 200;

export interface KeyServiceDeps {
  auth: AuthCollections;
  devices: DeviceCollections;
  oneTimeKeys: Collection<OneTimeKeyDoc>;
  clock: Clock;
  claimBudget: Budget;
  /** Called with the devices whose keys were just claimed (the gateway's low-key notice). */
  onClaimed?: (deviceIds: string[]) => void;
}

function isSigned(kind: 'one_time' | 'fallback', device: DeviceDoc, key: SignedKey): boolean {
  try {
    return verifyEd25519(
      device.identityKeys.ed25519,
      signedKeyMessage(kind, device._id, key.keyId, key.publicKey),
      key.signature,
    );
  } catch (error) {
    if (error instanceof ProtocolError) return false;
    throw error;
  }
}

function isDuplicateKeyBatch(error: unknown): boolean {
  const writeErrors = (error as { writeErrors?: { code?: number }[] } | null)?.writeErrors;
  return Array.isArray(writeErrors) && writeErrors.every((writeError) => writeError.code === 11000);
}

export class KeyService {
  readonly #claims: WindowCounter;

  constructor(private readonly d: KeyServiceDeps) {
    this.#claims = new WindowCounter(d.claimBudget.limit, d.claimBudget.windowMs, d.clock);
  }

  /** The caller's own active device; key uploads need a device-bound session. */
  async #ownDevice(auth: AuthContext): Promise<DeviceDoc> {
    if (!auth.deviceId) throw new AppError('DEVICE_REQUIRED');
    const device = await this.d.devices.devices.findOne({
      _id: auth.deviceId,
      userId: auth.userId,
      status: 'active',
    });
    if (!device) throw new AppError('DEVICE_REVOKED');
    return device;
  }

  async upload(auth: AuthContext, input: UploadKeysRequest): Promise<number> {
    const device = await this.#ownDevice(auth);
    const unsigned =
      input.oneTimeKeys.some((key) => !isSigned('one_time', device, key)) ||
      (input.fallbackKey !== undefined && !isSigned('fallback', device, input.fallbackKey));
    if (unsigned)
      throw new AppError('INVALID_SIGNATURE', { detail: 'A key signature is invalid.' });

    const { oneTimeKeys } = this.d;
    const stored = await oneTimeKeys.countDocuments({ deviceId: device._id });
    if (stored + input.oneTimeKeys.length > MAX_STORED_ONE_TIME_KEYS) {
      throw new AppError('VALIDATION_FAILED', {
        detail: `A device may keep at most ${MAX_STORED_ONE_TIME_KEYS} unclaimed one-time keys.`,
      });
    }
    if (input.oneTimeKeys.length > 0) {
      const now = new Date(this.d.clock.now());
      try {
        await oneTimeKeys.insertMany(
          input.oneTimeKeys.map((key) => ({
            _id: `${device._id}:${key.keyId}`,
            deviceId: device._id,
            userId: auth.userId,
            keyId: key.keyId,
            publicKey: key.publicKey,
            signature: key.signature,
            createdAt: now,
          })),
          { ordered: false },
        );
      } catch (error) {
        // Re-uploading an already published key is a no-op.
        if (!isDuplicateKeyBatch(error)) throw error;
      }
    }
    if (input.fallbackKey) {
      await this.d.devices.devices.updateOne(
        { _id: device._id, status: 'active' },
        { $set: { fallbackKey: input.fallbackKey } },
      );
    }
    return oneTimeKeys.countDocuments({ deviceId: device._id });
  }

  async count(auth: AuthContext): Promise<number> {
    const device = await this.#ownDevice(auth);
    return this.d.oneTimeKeys.countDocuments({ deviceId: device._id });
  }

  async directory(userId: string): Promise<UserKeysResponse> {
    const user = await this.d.auth.users.findOne({ _id: userId, status: 'active' });
    if (!user) throw new AppError('NOT_FOUND');
    const devices = await this.d.devices.devices
      .find({ userId, status: 'active' })
      .sort({ createdAt: 1 })
      .toArray();
    return {
      userId,
      accountIdentityKey: user.accountIdentityKey,
      keyVersion: user.keyVersion,
      devices: devices.map((device): DirectoryDevice => ({
        deviceId: device._id,
        platform: device.platform,
        role: device.role,
        identityKeys: device.identityKeys,
        deviceCertificate: device.deviceCertificate,
        fallbackKey: device.fallbackKey,
      })),
    };
  }

  /** The owner of an active device (ADR 0011); revoked and unknown devices are NOT_FOUND. */
  async deviceOwner(deviceId: string): Promise<DeviceOwnerResponse> {
    const device = await this.d.devices.devices.findOne(
      { _id: deviceId, status: 'active' },
      { projection: { userId: 1 } },
    );
    if (!device) throw new AppError('NOT_FOUND');
    return { deviceId, userId: device.userId };
  }

  /**
   * Takes one one-time key per active device, atomically (`findOneAndDelete`): concurrent
   * claims never get the same key. A device with none left yields its fallback key; unknown
   * or revoked devices are left out.
   */
  async claim(auth: AuthContext, deviceIds: string[]): Promise<ClaimKeysResponse> {
    const unique = [...new Set(deviceIds)];
    for (let i = 0; i < unique.length; i++) {
      const budget = this.#claims.hit(auth.userId);
      if (!budget.allowed) {
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: budget.retryAfterSeconds });
      }
    }
    const devices = await this.d.devices.devices
      .find({ _id: { $in: unique }, status: 'active' })
      .toArray();
    const keys = await Promise.all(
      devices.map(async (device) => {
        const claimed = await this.d.oneTimeKeys.findOneAndDelete(
          { deviceId: device._id },
          { sort: { createdAt: 1 } },
        );
        if (claimed) {
          const key = {
            keyId: claimed.keyId,
            publicKey: claimed.publicKey,
            signature: claimed.signature,
          };
          return { deviceId: device._id, key, fallback: false };
        }
        return device.fallbackKey
          ? { deviceId: device._id, key: device.fallbackKey, fallback: true }
          : undefined;
      }),
    );
    const claimed = keys.filter((key) => key !== undefined);
    this.d.onClaimed?.(claimed.map((key) => key.deviceId));
    return { keys: claimed };
  }
}
