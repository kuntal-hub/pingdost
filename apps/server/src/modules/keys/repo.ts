/** The public key directory (REQ §15 crypto directory): published one-time keys. */
import type { Collection, Db } from 'mongodb';

import type { IndexSetup } from '../../infra/mongo';

export interface OneTimeKeyDoc {
  /** `${deviceId}:${keyId}`, so re-uploading a key is idempotent. */
  _id: string;
  deviceId: string;
  userId: string;
  keyId: string;
  /** Curve25519 public key (unpadded base64). */
  publicKey: string;
  /** The device's ed25519 signature over the key. */
  signature: string;
  createdAt: Date;
}

export function oneTimeKeys(db: Db): Collection<OneTimeKeyDoc> {
  return db.collection<OneTimeKeyDoc>('one_time_keys');
}

export const keyIndexes: IndexSetup = async (db) => {
  await oneTimeKeys(db).createIndex({ deviceId: 1, createdAt: 1 });
};
