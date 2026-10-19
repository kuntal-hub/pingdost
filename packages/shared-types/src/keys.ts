/** Key directory DTOs: `/v1/keys/*` (Phase 6). */
import { z } from 'zod';

import { IdSchema, UnpaddedBase64Schema } from './common';
import { DevicePlatformSchema, DeviceRoleSchema, IdentityKeysSchema } from './devices';

export const MAX_ONE_TIME_KEYS_PER_UPLOAD = 100;
export const MAX_CLAIM_DEVICES = 100;

/** A one-time or fallback Curve25519 key, signed by the device's ed25519 key. */
export const SignedKeySchema = z.object({
  keyId: z.string().min(1).max(64),
  publicKey: UnpaddedBase64Schema,
  signature: UnpaddedBase64Schema,
});
export type SignedKey = z.infer<typeof SignedKeySchema>;

// POST /v1/keys/otks
export const UploadKeysRequestSchema = z.object({
  oneTimeKeys: z.array(SignedKeySchema).max(MAX_ONE_TIME_KEYS_PER_UPLOAD),
  fallbackKey: SignedKeySchema.optional(),
});
export type UploadKeysRequest = z.infer<typeof UploadKeysRequestSchema>;

// POST /v1/keys/otks response, and GET /v1/keys/otks/count
export const OneTimeKeyCountSchema = z.object({ count: z.int().nonnegative() });
export type OneTimeKeyCount = z.infer<typeof OneTimeKeyCountSchema>;

export const DirectoryDeviceSchema = z.object({
  deviceId: IdSchema,
  platform: DevicePlatformSchema,
  role: DeviceRoleSchema,
  identityKeys: IdentityKeysSchema,
  /** Verify with the account identity key before trusting the device. */
  deviceCertificate: UnpaddedBase64Schema,
  /** Signed by the device; clients cache it for offline first contact (ADR 0003). */
  fallbackKey: SignedKeySchema.nullable(),
});
export type DirectoryDevice = z.infer<typeof DirectoryDeviceSchema>;

// GET /v1/keys/users/:userId (active devices only)
export const UserKeysResponseSchema = z.object({
  userId: IdSchema,
  /** Null until the account's first primary device registers. */
  accountIdentityKey: UnpaddedBase64Schema.nullable(),
  /** Bumped whenever the device list changes. */
  keyVersion: z.int().nonnegative(),
  devices: z.array(DirectoryDeviceSchema),
});
export type UserKeysResponse = z.infer<typeof UserKeysResponseSchema>;

// POST /v1/keys/claim
export const ClaimKeysRequestSchema = z.object({
  deviceIds: z.array(IdSchema).min(1).max(MAX_CLAIM_DEVICES),
});
export type ClaimKeysRequest = z.infer<typeof ClaimKeysRequestSchema>;

/** One key per device: a one-time key, or the fallback key when none remain. */
export const ClaimKeysResponseSchema = z.object({
  keys: z.array(z.object({ deviceId: IdSchema, key: SignedKeySchema, fallback: z.boolean() })),
});
export type ClaimKeysResponse = z.infer<typeof ClaimKeysResponseSchema>;
