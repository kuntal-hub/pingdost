/**
 * Auth collections (REQ §16.1, ARCHITECTURE A2): `users`, `sessions` and `email_otps`.
 * No plaintext passwords, OTPs or refresh tokens: only Argon2id and HMAC hashes.
 */
import type { Collection, Db } from 'mongodb';

import type { AuthProvider, PrivacyPrefs, UserStatus } from '@pingdost/shared-types';

import type { IndexSetup } from '../../infra/mongo';
import type { OtpPurpose } from '../email';

export interface UserDoc {
  /** UUIDv7. */
  _id: string;
  /** Lowercase; null until a Google user picks one (Phase 6). */
  username: string | null;
  /** Normalized (trimmed, lowercase). */
  email: string;
  /** Argon2id PHC string; null for social-only accounts. */
  passwordHash: string | null;
  authProviders: AuthProvider[];
  status: UserStatus;
  displayName: string | null;
  avatarUrl: string | null;
  privacy: PrivacyPrefs;
  /** Public Ed25519 account identity key (ADR 0003), set by the first primary device. */
  accountIdentityKey: string | null;
  /** Bumped whenever the account's device list or device keys change. */
  keyVersion: number;
  /** Google's stable `sub` once the account signs in with Google. */
  googleSub: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Set while `pending_verification`; the TTL index deletes the account after it. */
  pendingExpiresAt?: Date;
}

/** One refresh-token family: rotated on every refresh, revoked as a whole. */
export interface SessionDoc {
  /** UUIDv7; the `sid` claim. */
  _id: string;
  userId: string;
  /** Bound in Phase 6 (`did` claim). */
  deviceId: string | null;
  /** HMAC of the current refresh token. */
  refreshHash: string;
  /** HMACs of rotated-out tokens, for reuse detection (bounded). */
  usedRefreshHashes: string[];
  createdAt: Date;
  lastUsedAt: Date;
  /** Sliding refresh expiry; the TTL index removes the document after it. */
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  userAgent: string | null;
}

export interface OtpDoc {
  /** `${purpose}:${email}`: one live code per purpose and address. */
  _id: string;
  purpose: OtpPurpose;
  email: string;
  /** HMAC of the code. */
  codeHash: string;
  attempts: number;
  createdAt: Date;
  lastSentAt: Date;
  expiresAt: Date;
}

/** How many rotated-out refresh hashes a session remembers. */
export const USED_REFRESH_HASHES_KEPT = 50;

export const DEFAULT_PRIVACY: PrivacyPrefs = {
  readReceipts: true,
  deliveryReceipts: true,
  typingIndicators: true,
  lastSeen: true,
};

export interface AuthCollections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  otps: Collection<OtpDoc>;
}

export function authCollections(db: Db): AuthCollections {
  return {
    users: db.collection<UserDoc>('users'),
    sessions: db.collection<SessionDoc>('sessions'),
    otps: db.collection<OtpDoc>('email_otps'),
  };
}

export const authIndexes: IndexSetup = async (db) => {
  const { users, sessions, otps } = authCollections(db);
  await users.createIndex(
    { username: 1 },
    { unique: true, partialFilterExpression: { username: { $type: 'string' } } },
  );
  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex(
    { googleSub: 1 },
    { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } },
  );
  await users.createIndex({ pendingExpiresAt: 1 }, { expireAfterSeconds: 0 });

  await sessions.createIndex({ refreshHash: 1 }, { unique: true });
  await sessions.createIndex({ usedRefreshHashes: 1 });
  await sessions.createIndex({ userId: 1 });
  await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  await otps.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
};
