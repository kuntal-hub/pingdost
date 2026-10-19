import {
  AuthSessionSchema,
  AuthTokensSchema,
  AuthUserSchema,
  RegisterResponseSchema,
  type AuthSession,
  type AuthTokens,
  type AuthUser,
  type LoginRequest,
  type PasswordChangeRequest,
  type PasswordResetRequest,
  type RegisterRequest,
  type RegisterResponse,
  type VerifyEmailRequest,
} from '@pingdost/shared-types';

import type { ApiClient } from './client';

/** `/v1/auth/*` (Phases 5–6). `/v1/me` lives in `accountApi`. */
export interface AuthApi {
  register(body: RegisterRequest): Promise<RegisterResponse>;
  verifyEmail(body: VerifyEmailRequest): Promise<AuthSession>;
  resendVerification(email: string): Promise<void>;
  login(body: LoginRequest): Promise<AuthSession>;
  /** Rotates the refresh token: store the new pair before using it. */
  refresh(refreshToken: string): Promise<AuthTokens>;
  logout(): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  resetPassword(body: PasswordResetRequest): Promise<void>;
  changePassword(body: PasswordChangeRequest): Promise<void>;
  /** Google sign-in with an ID token (Phase 6). */
  google(idToken: string): Promise<AuthSession>;
  /** Picks the username of a new Google account. */
  completeGoogle(username: string): Promise<AuthUser>;
}

export function authApi(client: ApiClient): AuthApi {
  return {
    register: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/register',
        body,
        auth: false,
        response: RegisterResponseSchema,
      }),
    verifyEmail: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/email/verify',
        body,
        auth: false,
        response: AuthSessionSchema,
      }),
    resendVerification: (email) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/email/resend',
        body: { email },
        auth: false,
      }),
    login: (body) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/login',
        body,
        auth: false,
        response: AuthSessionSchema,
      }),
    refresh: (refreshToken) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/refresh',
        body: { refreshToken },
        auth: false,
        response: AuthTokensSchema,
      }),
    logout: () => client.request({ method: 'POST', path: '/v1/auth/logout' }),
    forgotPassword: (email) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/password/forgot',
        body: { email },
        auth: false,
      }),
    resetPassword: (body) =>
      client.request({ method: 'POST', path: '/v1/auth/password/reset', body, auth: false }),
    changePassword: (body) =>
      client.request({ method: 'POST', path: '/v1/auth/password/change', body }),
    google: (idToken) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/google',
        body: { idToken },
        auth: false,
        response: AuthSessionSchema,
      }),
    completeGoogle: (username) =>
      client.request({
        method: 'POST',
        path: '/v1/auth/google/complete',
        body: { username },
        response: AuthUserSchema,
      }),
  };
}
