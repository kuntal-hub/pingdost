/**
 * Web pairing requests (REQ §13.1, ADR 0019): short-lived, single-use, deleted by a TTL index
 * once they expire. Public keys and hashes only; the poll secret is stored as a keyed hash.
 */
import type { Collection, Db } from 'mongodb';

import type { IdentityKeys } from '@pingdost/shared-types';

import type { IndexSetup } from '../../infra/mongo';

export type PairingState = 'pending' | 'approved' | 'completed';

export interface PairingDoc {
  /** UUIDv7: the pairing ID in the QR code. */
  _id: string;
  /** 32 random bytes (base64url), shown in the QR code. */
  challenge: string;
  /** HMAC of the browser's poll secret. */
  pollSecretHash: string;
  /** The browser's Olm identity keys. */
  identityKeys: IdentityKeys;
  name: string;
  /** First 128 characters of the requesting browser's user agent. */
  userAgent: string | null;
  state: PairingState;
  createdAt: Date;
  /** The request stops working then, and the TTL index deletes it soon after. */
  expiresAt: Date;
  // Set when the primary phone approves:
  userId: string | null;
  deviceId: string | null;
  deviceCertificate: string | null;
  approvedBy: string | null;
  /** The browser signs this to prove it holds the keys (base64url, 32 bytes). */
  nonce: string | null;
  approvedAt: Date | null;
  completedAt: Date | null;
}

export function pairingRequests(db: Db): Collection<PairingDoc> {
  return db.collection<PairingDoc>('pairing_requests');
}

export const pairingIndexes: IndexSetup = async (db) => {
  // The cleanup: MongoDB deletes each request shortly after it expires.
  await pairingRequests(db).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
};
