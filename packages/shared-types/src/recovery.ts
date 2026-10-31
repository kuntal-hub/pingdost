/**
 * Replacing the primary phone (Phase 19, ADR 0022):
 * - `/v1/devices/primary-transfer*`: the old phone approves the new one (path a);
 * - `/v1/devices/primary-replace*`: an email code plus a backup's account key (path b), or a
 *   fresh account key (path c).
 * The new phone calls these with a recent, device-less session.
 */
import { z } from 'zod';

import { OtpSchema } from './auth';
import { Base64UrlSchema, EpochMsSchema, IdSchema, UnpaddedBase64Schema } from './common';
import {
  DeviceNameSchema,
  DevicePlatformSchema,
  IdentityKeysSchema,
  RegisterDeviceRequestSchema,
} from './devices';
import { SignedKeySchema } from './keys';

/** A login newer than this counts as recent for these routes. */
export const RECENT_LOGIN_SECONDS = 15 * 60;

export const PrimaryTransferStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
  'completed',
]);
export type PrimaryTransferStatus = z.infer<typeof PrimaryTransferStatusSchema>;

// POST /v1/devices/primary-transfer (the new phone)
export const StartPrimaryTransferRequestSchema = z.object({
  /** Client-generated UUIDv7 for the new phone. */
  deviceId: IdSchema,
  platform: z.enum(['android', 'ios']),
  name: DeviceNameSchema,
  identityKeys: IdentityKeysSchema,
  /** Signed by the new phone's ed25519 key; the old phone opens an Olm session with it. */
  oneTimeKey: SignedKeySchema,
});
export type StartPrimaryTransferRequest = z.infer<typeof StartPrimaryTransferRequestSchema>;

export const StartPrimaryTransferResponseSchema = z.object({
  requestId: IdSchema,
  expiresAt: EpochMsSchema,
});
export type StartPrimaryTransferResponse = z.infer<typeof StartPrimaryTransferResponseSchema>;

/** An Olm pre-key message body (standard base64). */
export const SealedPayloadSchema = z.base64().max(8192);

// GET /v1/devices/primary-transfer/:requestId (the new phone polls)
export const PrimaryTransferStatusResponseSchema = z.object({
  status: PrimaryTransferStatusSchema,
  /** Once approved. */
  approval: z
    .object({
      /** The new phone signs this to complete (proof of possession). */
      nonce: Base64UrlSchema,
      deviceCertificate: UnpaddedBase64Schema,
      /** The approving phone's Curve25519 identity key, to open the sealed message. */
      senderKey: UnpaddedBase64Schema,
      sealed: SealedPayloadSchema,
    })
    .nullable(),
});
export type PrimaryTransferStatusResponse = z.infer<typeof PrimaryTransferStatusResponseSchema>;

// GET /v1/devices/primary-transfer (the account's devices: pending requests)
export const PendingPrimaryTransferSchema = z.object({
  requestId: IdSchema,
  deviceId: IdSchema,
  platform: DevicePlatformSchema,
  name: DeviceNameSchema,
  identityKeys: IdentityKeysSchema,
  oneTimeKey: SignedKeySchema,
  createdAt: EpochMsSchema,
  expiresAt: EpochMsSchema,
});
export type PendingPrimaryTransfer = z.infer<typeof PendingPrimaryTransferSchema>;

export const ListPrimaryTransfersResponseSchema = z.object({
  requests: z.array(PendingPrimaryTransferSchema),
});
export type ListPrimaryTransfersResponse = z.infer<typeof ListPrimaryTransfersResponseSchema>;

// POST /v1/devices/primary-transfer/:requestId/approve (the active primary) → 204
export const ApprovePrimaryTransferRequestSchema = z.object({
  /** The account identity key's certificate for the new phone's keys. */
  deviceCertificate: UnpaddedBase64Schema,
  /** Olm pre-key message to the new phone's one-time key: the account identity key. */
  sealed: SealedPayloadSchema,
});
export type ApprovePrimaryTransferRequest = z.infer<typeof ApprovePrimaryTransferRequestSchema>;

// POST /v1/devices/primary-transfer/:requestId/deny (any device of the account) → 204

// POST /v1/devices/primary-transfer/:requestId/complete (the new phone) → RegisterDeviceResponse
export const CompletePrimaryTransferRequestSchema = z.object({
  /** The new phone's ed25519 signature over the registration message with `approval.nonce`. */
  signature: UnpaddedBase64Schema,
});
export type CompletePrimaryTransferRequest = z.infer<typeof CompletePrimaryTransferRequestSchema>;

// POST /v1/devices/primary-replace/otp (the new phone) → 204: emails a code.

// POST /v1/devices/primary-replace (the new phone) → RegisterDeviceResponse
export const ReplacePrimaryModeSchema = z.enum(['restore', 'fresh']);
export type ReplacePrimaryMode = z.infer<typeof ReplacePrimaryModeSchema>;

export const ReplacePrimaryRequestSchema = RegisterDeviceRequestSchema.extend({
  otp: OtpSchema,
  /**
   * `restore`: the account identity key from a backup certifies the new phone (same safety
   * number). `fresh`: a new account identity key (`accountIdentityKey` required); every
   * device is signed out and contacts see a new safety number.
   */
  mode: ReplacePrimaryModeSchema,
});
export type ReplacePrimaryRequest = z.infer<typeof ReplacePrimaryRequestSchema>;
