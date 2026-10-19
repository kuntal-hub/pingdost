/**
 * Device registration and revocation (REQ §6.2, ADR 0003, ADR 0008).
 *
 * Registration needs a fresh server nonce signed by the device's ed25519 key (proof of
 * possession) and a device certificate signed by the account identity key. The server checks
 * both and stores public keys only; clients verify certificates themselves before trusting a
 * device.
 */
import type { Collection } from 'mongodb';

import {
  deviceCertificateMessage,
  deviceRegistrationMessage,
  ProtocolError,
} from '@pingdost/protocol';
import type {
  DeviceChallengeResponse,
  DeviceSummary,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
} from '@pingdost/shared-types';

import { startOfDay, type DeviceCollections, type DeviceDoc } from './repo';
import type { Clock } from '../../infra/clock';
import { verifyEd25519 } from '../../infra/ed25519';
import { AppError } from '../../infra/errors';
import { duplicateKeyField } from '../../infra/mongo';
import { randomToken } from '../../infra/secrets';
import type { AuthContext } from '../auth/guard';
import type { AuthCollections } from '../auth/repo';
import type { AuthService } from '../auth/service';
import type { OneTimeKeyDoc } from '../keys/repo';
import type { RequestContext, SecurityEvents } from '../security/events';

const CHALLENGE_TTL_MS = 5 * 60_000;

/** Called after a device is revoked; Phase 8 pushes `Revoked` to its live socket. */
export type DeviceRevokedHook = (deviceId: string) => void;

export interface DeviceServiceDeps {
  devices: DeviceCollections;
  auth: AuthCollections;
  oneTimeKeys: Collection<OneTimeKeyDoc>;
  authService: AuthService;
  events: SecurityEvents;
  clock: Clock;
  onRevoked?: DeviceRevokedHook[];
}

export function toSummary(device: DeviceDoc): DeviceSummary {
  return {
    deviceId: device._id,
    platform: device.platform,
    role: device.role,
    name: device.name,
    status: device.status,
    createdAt: device.createdAt.getTime(),
    lastSeenAt: device.lastSeenAt?.getTime() ?? null,
    revokedAt: device.revokedAt?.getTime() ?? null,
  };
}

function signatureOk(publicKey: string, message: () => Uint8Array, signature: string): boolean {
  try {
    return verifyEd25519(publicKey, message(), signature);
  } catch (error) {
    // Keys or IDs of the wrong size cannot have been signed correctly.
    if (error instanceof ProtocolError) return false;
    throw error;
  }
}

export class DeviceService {
  constructor(private readonly d: DeviceServiceDeps) {}

  async challenge(auth: AuthContext): Promise<DeviceChallengeResponse> {
    const expiresAt = this.d.clock.now() + CHALLENGE_TTL_MS;
    const nonce = randomToken(32);
    await this.d.devices.challenges.insertOne({
      _id: nonce,
      userId: auth.userId,
      expiresAt: new Date(expiresAt),
    });
    return { nonce, expiresAt };
  }

  async register(
    auth: AuthContext,
    input: RegisterDeviceRequest,
    context: RequestContext,
  ): Promise<RegisterDeviceResponse> {
    const { users } = this.d.auth;
    const now = this.d.clock.now();
    const user = await users.findOne({ _id: auth.userId });
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (user.status === 'pending_username') throw new AppError('USERNAME_REQUIRED');
    if (user.status !== 'active') throw new AppError('FORBIDDEN');
    if (auth.deviceId) {
      throw new AppError('CONFLICT', { detail: 'This session already has a device.' });
    }

    const challenge = await this.d.devices.challenges.findOneAndDelete({
      _id: input.nonce,
      userId: auth.userId,
      expiresAt: { $gt: new Date(now) },
    });
    if (!challenge) throw new AppError('CHALLENGE_EXPIRED');

    const keys = input.identityKeys;
    if (
      !signatureOk(
        keys.ed25519,
        () => deviceRegistrationMessage(input.nonce, input.deviceId, keys),
        input.signature,
      )
    ) {
      throw new AppError('INVALID_SIGNATURE', { detail: 'Proof of possession failed.' });
    }

    const accountKey = user.accountIdentityKey ?? input.accountIdentityKey;
    if (!accountKey) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The first device must send the account identity key.',
      });
    }
    if (input.accountIdentityKey && input.accountIdentityKey !== accountKey) {
      throw new AppError('IDENTITY_KEY_MISMATCH');
    }
    if (
      !signatureOk(
        accountKey,
        () => deviceCertificateMessage(input.deviceId, keys),
        input.deviceCertificate,
      )
    ) {
      throw new AppError('INVALID_SIGNATURE', { detail: 'The device certificate is invalid.' });
    }
    if (!user.accountIdentityKey) {
      // Set once; a concurrent first registration with another key loses.
      const set = await users.updateOne(
        { _id: user._id, accountIdentityKey: null },
        { $set: { accountIdentityKey: accountKey, updatedAt: new Date(now) } },
      );
      if (set.modifiedCount === 0) throw new AppError('IDENTITY_KEY_MISMATCH');
    }

    const device: DeviceDoc = {
      _id: input.deviceId,
      userId: user._id,
      platform: input.platform,
      role: 'primary',
      name: input.name,
      identityKeys: { curve25519: keys.curve25519, ed25519: keys.ed25519 },
      deviceCertificate: input.deviceCertificate,
      fallbackKey: null,
      keyVersion: 1,
      status: 'active',
      createdAt: new Date(now),
      revokedAt: null,
      lastSeenAt: startOfDay(now),
    };
    try {
      await this.d.devices.devices.insertOne(device);
    } catch (error) {
      const field = duplicateKeyField(error);
      if (field === 'userId') throw new AppError('PRIMARY_EXISTS');
      if (field === '_id') throw new AppError('CONFLICT', { detail: 'Device ID already in use.' });
      throw error;
    }
    await users.updateOne({ _id: user._id }, { $inc: { keyVersion: 1 } });

    const tokens = await this.d.authService.bindDevice(auth.sessionId, device._id);
    await this.d.events.record('device_register', context, user._id);
    return { device: toSummary(device), tokens };
  }

  async list(userId: string): Promise<DeviceSummary[]> {
    const devices = await this.d.devices.devices.find({ userId }).sort({ createdAt: 1 }).toArray();
    return devices.map(toSummary);
  }

  /**
   * Revokes a device of the caller's account. The primary may revoke any linked device; any
   * device may revoke itself. Replacing a lost primary is the recovery flow (Phase 19).
   */
  async revoke(auth: AuthContext, deviceId: string, context: RequestContext): Promise<void> {
    const { devices } = this.d.devices;
    const target = await devices.findOne({ _id: deviceId, userId: auth.userId });
    if (!target) throw new AppError('DEVICE_NOT_FOUND');
    if (!auth.deviceId) throw new AppError('DEVICE_REQUIRED');
    const caller = await devices.findOne({ _id: auth.deviceId, status: 'active' });
    const allowed =
      caller !== null &&
      (caller._id === target._id || (caller.role === 'primary' && target.role === 'linked'));
    if (!allowed) throw new AppError('FORBIDDEN');
    if (target.status === 'revoked') return;

    const now = new Date(this.d.clock.now());
    const revoked = await devices.updateOne(
      { _id: target._id, status: 'active' },
      { $set: { status: 'revoked', revokedAt: now, fallbackKey: null } },
    );
    if (revoked.modifiedCount === 0) return;
    await this.d.oneTimeKeys.deleteMany({ deviceId: target._id });
    await this.d.auth.sessions.updateMany(
      { deviceId: target._id, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: 'device_revoked' } },
    );
    await this.d.auth.users.updateOne({ _id: auth.userId }, { $inc: { keyVersion: 1 } });
    await this.d.events.record('device_revoke', context, auth.userId);
    for (const hook of this.d.onRevoked ?? []) hook(target._id);
  }

  /** Records coarse last-seen (one write per device per UTC day at most). */
  touch(deviceId: string): void {
    const today = startOfDay(this.d.clock.now());
    void this.d.devices.devices
      .updateOne({ _id: deviceId, lastSeenAt: { $lt: today } }, { $set: { lastSeenAt: today } })
      .catch(() => undefined);
  }
}
