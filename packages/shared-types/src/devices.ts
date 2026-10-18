/** Device DTOs: `/v1/devices*` (Phase 6). */
import { z } from 'zod';

import { AuthTokensSchema } from './auth';
import { Base64UrlSchema, EpochMsSchema, IdSchema, UnpaddedBase64Schema } from './common';

export const DevicePlatformSchema = z.enum(['android', 'ios', 'web']);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceRoleSchema = z.enum(['primary', 'linked']);
export type DeviceRole = z.infer<typeof DeviceRoleSchema>;

export const DeviceStatusSchema = z.enum(['active', 'revoked']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const DeviceNameSchema = z.string().trim().min(1).max(64);

/** A device's Olm identity keys (unpadded base64, as vodozemac reports them). */
export const IdentityKeysSchema = z.object({
  curve25519: UnpaddedBase64Schema,
  ed25519: UnpaddedBase64Schema,
});
export type IdentityKeys = z.infer<typeof IdentityKeysSchema>;

export const DeviceSummarySchema = z.object({
  deviceId: IdSchema,
  platform: DevicePlatformSchema,
  role: DeviceRoleSchema,
  name: DeviceNameSchema,
  status: DeviceStatusSchema,
  createdAt: EpochMsSchema,
  /** Day granularity. */
  lastSeenAt: EpochMsSchema.nullable(),
  revokedAt: EpochMsSchema.nullable(),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

// POST /v1/devices/challenge
export const DeviceChallengeResponseSchema = z.object({
  nonce: Base64UrlSchema,
  expiresAt: EpochMsSchema,
});
export type DeviceChallengeResponse = z.infer<typeof DeviceChallengeResponseSchema>;

// POST /v1/devices (Android/iOS only; web devices register through pairing)
export const RegisterDeviceRequestSchema = z.object({
  /** Client-generated UUIDv7. */
  deviceId: IdSchema,
  platform: z.enum(['android', 'ios']),
  name: DeviceNameSchema,
  identityKeys: IdentityKeysSchema,
  nonce: Base64UrlSchema,
  /** Device ed25519 signature over `nonce ‖ deviceId ‖ identity keys` (proof of possession). */
  signature: UnpaddedBase64Schema,
  /** Account identity key signature over `deviceId ‖ curve25519 ‖ ed25519` (ADR 0003). */
  deviceCertificate: UnpaddedBase64Schema,
  /** The public account identity key; sent by the first primary device. */
  accountIdentityKey: UnpaddedBase64Schema.optional(),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

/** The registered device and a token pair bound to it (`did` claim). */
export const RegisterDeviceResponseSchema = z.object({
  device: DeviceSummarySchema,
  tokens: AuthTokensSchema,
});
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponseSchema>;

// GET /v1/devices
export const ListDevicesResponseSchema = z.object({ devices: z.array(DeviceSummarySchema) });
export type ListDevicesResponse = z.infer<typeof ListDevicesResponseSchema>;

// DELETE /v1/devices/:deviceId → 204
