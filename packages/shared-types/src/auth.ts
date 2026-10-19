/** Auth DTOs: `/v1/auth/*` (Phase 5; Google sign-in in Phase 6). */
import { z } from 'zod';

import { EpochMsSchema, IdSchema } from './common';

/** 3–20 characters of `[a-z0-9_.]`, compared case-insensitively. */
export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(20)
  .regex(/^[a-z0-9_.]+$/, 'letters, digits, _ and . only');

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const PasswordSchema = z.string().min(10).max(128);

export const OtpSchema = z.string().regex(/^\d{6}$/, 'must be 6 digits');

export const UserStatusSchema = z.enum([
  'pending_verification',
  'pending_username',
  'active',
  'disabled',
]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const AuthProviderSchema = z.enum(['password', 'google']);
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

/** Access token (JWT) plus a rotating refresh token. Secrets: never logged. */
export const AuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: EpochMsSchema,
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: EpochMsSchema,
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const AuthUserSchema = z.object({
  userId: IdSchema,
  username: UsernameSchema.nullable(),
  status: UserStatusSchema,
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthSessionSchema = z.object({
  user: AuthUserSchema,
  tokens: AuthTokensSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

// POST /v1/auth/register
export const RegisterRequestSchema = z.object({
  username: UsernameSchema,
  email: EmailSchema,
  password: PasswordSchema,
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export const RegisterResponseSchema = z.object({
  userId: IdSchema,
  status: UserStatusSchema,
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

// POST /v1/auth/email/verify → AuthSession
export const VerifyEmailRequestSchema = z.object({ email: EmailSchema, otp: OtpSchema });
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

// POST /v1/auth/email/resend, POST /v1/auth/password/forgot → 204
export const EmailRequestSchema = z.object({ email: EmailSchema });
export type EmailRequest = z.infer<typeof EmailRequestSchema>;

// POST /v1/auth/login → AuthSession
export const LoginRequestSchema = z.object({
  /** Email or username. */
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

// POST /v1/auth/refresh → AuthTokens
export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1).max(512) });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

// POST /v1/auth/password/reset → 204
export const PasswordResetRequestSchema = z.object({
  email: EmailSchema,
  otp: OtpSchema,
  newPassword: PasswordSchema,
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

// POST /v1/auth/password/change → 204
export const PasswordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: PasswordSchema,
});
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>;

// POST /v1/auth/google → AuthSession (status `pending_username` until completed)
export const GoogleSignInRequestSchema = z.object({ idToken: z.string().min(1).max(8192) });
export type GoogleSignInRequest = z.infer<typeof GoogleSignInRequestSchema>;

// POST /v1/auth/google/complete (authenticated, `pending_username`) → AuthUser; the session's
// tokens stay valid.
export const GoogleCompleteRequestSchema = z.object({ username: UsernameSchema });
export type GoogleCompleteRequest = z.infer<typeof GoogleCompleteRequestSchema>;
