/** Web pairing DTOs: `/v1/pairing/*` (Phase 16, ADR 0019). */
import { z } from 'zod';

import { Base64UrlSchema, EpochMsSchema, IdSchema, UnpaddedBase64Schema } from './common';
import { DeviceNameSchema, IdentityKeysSchema, RegisterDeviceResponseSchema } from './devices';

/**
 * `pending`: waiting for the phone; `approved`: the browser may complete it now; `expired`: too
 * late (create a new one). A completed request reads as `PAIRING_ALREADY_USED`.
 */
export const PairingStatusSchema = z.enum(['pending', 'approved', 'expired']);
export type PairingStatus = z.infer<typeof PairingStatusSchema>;

// POST /v1/pairing/requests (unauthenticated; the web client) → 201
export const CreatePairingRequestSchema = z.object({
  identityKeys: IdentityKeysSchema,
  /** What the phone shows, e.g. "Chrome on Windows". */
  name: DeviceNameSchema,
});
export type CreatePairingRequest = z.infer<typeof CreatePairingRequestSchema>;

/** Shown to the phone as a QR code (except `pollSecret`, which stays in the browser). */
export const CreatePairingResponseSchema = z.object({
  pairingId: IdSchema,
  challenge: Base64UrlSchema,
  /** Secret: authorizes polling and completing. */
  pollSecret: Base64UrlSchema,
  expiresAt: EpochMsSchema,
});
export type CreatePairingResponse = z.infer<typeof CreatePairingResponseSchema>;

// POST /v1/pairing/inspect (the primary phone, after scanning)
export const InspectPairingRequestSchema = z.object({
  pairingId: IdSchema,
  challenge: Base64UrlSchema,
});
export type InspectPairingRequest = z.infer<typeof InspectPairingRequestSchema>;

/** What the phone shows before the user approves. */
export const InspectPairingResponseSchema = z.object({
  name: DeviceNameSchema,
  /** The browser's user agent as the server saw it (first 128 characters). */
  userAgent: z.string().max(128).nullable(),
  identityKeys: IdentityKeysSchema,
  createdAt: EpochMsSchema,
  expiresAt: EpochMsSchema,
});
export type InspectPairingResponse = z.infer<typeof InspectPairingResponseSchema>;

// POST /v1/pairing/approve (the primary phone) → 204
export const ApprovePairingRequestSchema = z.object({
  pairingId: IdSchema,
  challenge: Base64UrlSchema,
  /** The browser's device ID, a UUIDv7 the phone picks and certifies. */
  deviceId: IdSchema,
  webKeys: IdentityKeysSchema,
  /** The phone's device ed25519 signature over `pairingApprovalMessage`. */
  signature: UnpaddedBase64Schema,
  /** Account identity key signature over the web device's keys (ADR 0003). */
  deviceCertificate: UnpaddedBase64Schema,
});
export type ApprovePairingRequest = z.infer<typeof ApprovePairingRequestSchema>;

// GET /v1/pairing/requests/:pairingId (header `x-pairing-secret: <pollSecret>`)
export const PairingStatusResponseSchema = z.object({
  status: PairingStatusSchema,
  /** Once approved: the new web device ID and a nonce for it to sign. */
  deviceId: IdSchema.optional(),
  nonce: Base64UrlSchema.optional(),
});
export type PairingStatusResponse = z.infer<typeof PairingStatusResponseSchema>;

/** The header that carries the poll secret (never a URL, which ends up in logs). */
export const PAIRING_SECRET_HEADER = 'x-pairing-secret';

// POST /v1/pairing/requests/:pairingId/complete → 201 RegisterDeviceResponse
export const CompletePairingRequestSchema = z.object({
  pollSecret: Base64UrlSchema,
  /** The web device's ed25519 signature over `deviceRegistrationMessage(nonce, deviceId, keys)`. */
  signature: UnpaddedBase64Schema,
});
export type CompletePairingRequest = z.infer<typeof CompletePairingRequestSchema>;
export const CompletePairingResponseSchema = RegisterDeviceResponseSchema;
