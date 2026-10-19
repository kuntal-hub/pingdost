/** Account and profile DTOs: `/v1/me`, `/v1/users/*` (Phases 5–6). */
import { z } from 'zod';

import { AuthProviderSchema, EmailSchema, UsernameSchema, UserStatusSchema } from './auth';
import { EpochMsSchema, IdSchema } from './common';

export const DisplayNameSchema = z.string().trim().min(1).max(64);

/** Clients honour these; the server only stores them (it enforces only `lastSeen`). */
export const PrivacyPrefsSchema = z.object({
  /** Off: no read receipts are sent, and other people's are not shown (reciprocal). */
  readReceipts: z.boolean(),
  /** Off: this account's devices send no delivery receipts (Phase 11). */
  deliveryReceipts: z.boolean(),
  typingIndicators: z.boolean(),
  lastSeen: z.boolean(),
});
export type PrivacyPrefs = z.infer<typeof PrivacyPrefsSchema>;

// GET /v1/me
export const MeResponseSchema = z.object({
  userId: IdSchema,
  username: UsernameSchema.nullable(),
  email: EmailSchema,
  status: UserStatusSchema,
  authProviders: z.array(AuthProviderSchema),
  displayName: DisplayNameSchema.nullable(),
  avatarUrl: z.url().nullable(),
  privacy: PrivacyPrefsSchema,
  /** Public Ed25519 account identity key (ADR 0003), once the primary device set it. */
  accountIdentityKey: z.string().nullable(),
  createdAt: EpochMsSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// PATCH /v1/me → MeResponse
export const UpdateMeRequestSchema = z.object({
  displayName: DisplayNameSchema.nullable().optional(),
  /** A Cloudinary `secure_url` under our cloud and `avatars/` folder, or null to remove. */
  avatarUrl: z.url().nullable().optional(),
  privacy: PrivacyPrefsSchema.partial().optional(),
});
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;

// GET /v1/users/by-username/:username (exact match only)
export const UserLookupResponseSchema = z.object({
  userId: IdSchema,
  username: UsernameSchema,
  displayName: DisplayNameSchema.nullable(),
  avatarUrl: z.url().nullable(),
});
export type UserLookupResponse = z.infer<typeof UserLookupResponseSchema>;

// POST /v1/me/avatar/sign: signed Cloudinary upload parameters (Phase 6 checks the API).
export const AvatarUploadSignatureSchema = z.object({
  uploadUrl: z.url(),
  /** Form fields to send with the file, including the signature. */
  fields: z.record(z.string(), z.string()),
  maxBytes: z.int().positive(),
});
export type AvatarUploadSignature = z.infer<typeof AvatarUploadSignatureSchema>;
