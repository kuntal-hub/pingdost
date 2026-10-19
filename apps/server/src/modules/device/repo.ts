/**
 * The device registry (REQ §6.2, §16.2): public keys and status only. Private keys never
 * reach the server.
 */
import type { Collection, Db } from 'mongodb';

import type {
  DevicePlatform,
  DeviceRole,
  DeviceStatus,
  IdentityKeys,
  SignedKey,
} from '@pingdost/shared-types';

import type { IndexSetup } from '../../infra/mongo';

export interface DeviceDoc {
  /** Client-generated UUIDv7. */
  _id: string;
  userId: string;
  platform: DevicePlatform;
  role: DeviceRole;
  name: string;
  identityKeys: IdentityKeys;
  /** The account identity key's signature over the device's keys. */
  deviceCertificate: string;
  fallbackKey: SignedKey | null;
  /** Version of this device's keys (key rotation is not supported yet). */
  keyVersion: number;
  status: DeviceStatus;
  createdAt: Date;
  revokedAt: Date | null;
  /** Start of the UTC day of the last authenticated request (coarse on purpose). */
  lastSeenAt: Date | null;
}

/** A one-time nonce a device signs to prove it holds its keys. */
export interface DeviceChallengeDoc {
  /** The nonce (base64url). */
  _id: string;
  userId: string;
  expiresAt: Date;
}

export interface DeviceCollections {
  devices: Collection<DeviceDoc>;
  challenges: Collection<DeviceChallengeDoc>;
}

export function deviceCollections(db: Db): DeviceCollections {
  return {
    devices: db.collection<DeviceDoc>('devices'),
    challenges: db.collection<DeviceChallengeDoc>('device_challenges'),
  };
}

/** Index name used to recognise the "one active primary" violation. */
export const ONE_ACTIVE_PRIMARY = 'one_active_primary';

export const deviceIndexes: IndexSetup = async (db) => {
  const { devices, challenges } = deviceCollections(db);
  await devices.createIndex({ userId: 1, createdAt: 1 });
  // REQ §6.2: one active primary mobile device per account.
  await devices.createIndex(
    { userId: 1, role: 1 },
    {
      name: ONE_ACTIVE_PRIMARY,
      unique: true,
      partialFilterExpression: { role: 'primary', status: 'active' },
    },
  );
  await challenges.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
};

/** Start of the UTC day containing `ms`. */
export function startOfDay(ms: number): Date {
  const date = new Date(ms);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
