/** Web pairing DTOs: `/v1/pairing/*` (Phase 16; its ADR finalizes the flow). */
import { z } from 'zod';

import { Base64UrlSchema, EpochMsSchema, IdSchema, UnpaddedBase64Schema } from './common';
import { DeviceNameSchema, IdentityKeysSchema, RegisterDeviceResponseSchema } from './devices';

export const PairingStatusSchema = z.enum(['pending', 'approved', 'expired']);
export type PairingStatus = z.infer<typeof PairingStatusSchema>;

// POST /v1/pairing/requests (unauthenticated; the web client)
export const CreatePairingRequestSchema = z.object({
  identityKeys: IdentityKeysSchema,
  name: DeviceNameSchema,
});
export type CreatePairingRequest = z.infer<typeof CreatePairingRequestSchema>;

/** Shown to the phone as a QR code (except `pollSecret`, which stays in the browser). */
export const CreatePairingResponseSchema = z.object({
  pairingId: IdSchema,
  challenge: Base64UrlSchema,
  /** Secret: authorizes polling. */
  pollSecret: Base64UrlSchema,
  expiresAt: EpochMsSchema,
});
export type CreatePairingResponse = z.infer<typeof CreatePairingResponseSchema>;

// POST /v1/pairing/approve (the primary phone) → 204
export const ApprovePairingRequestSchema = z.object({
  pairingId: IdSchema,
  challenge: Base64UrlSchema,
  webKeys: IdentityKeysSchema,
  /** The phone's device ed25519 signature over the pairing. */
  signature: UnpaddedBase64Schema,
  /** Account identity key signature over the web device's keys (ADR 0003). */
  deviceCertificate: UnpaddedBase64Schema,
});
export type ApprovePairingRequest = z.infer<typeof ApprovePairingRequestSchema>;

// GET /v1/pairing/requests/:pairingId (with the poll secret)
export const PairingStatusResponseSchema = z.object({
  status: PairingStatusSchema,
  /** Once approved: the new web device ID and a nonce for it to sign. */
  deviceId: IdSchema.optional(),
  nonce: Base64UrlSchema.optional(),
});
export type PairingStatusResponse = z.infer<typeof PairingStatusResponseSchema>;

// POST /v1/pairing/requests/:pairingId/complete → RegisterDeviceResponse
export const CompletePairingRequestSchema = z.object({
  pollSecret: Base64UrlSchema,
  /** The web device's ed25519 signature over the nonce. */
  signature: UnpaddedBase64Schema,
});
export type CompletePairingRequest = z.infer<typeof CompletePairingRequestSchema>;
export const CompletePairingResponseSchema = RegisterDeviceResponseSchema;
