/**
 * Google sign-in by ID token (ARCHITECTURE A2): the client obtains an ID token, and the
 * server verifies it against Google's JWKS. No redirect callback and no client secret.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export interface GoogleIdentity {
  /** Google's stable account ID. */
  sub: string;
  /** Normalized (trimmed, lowercase). */
  email: string;
  emailVerified: boolean;
}

export class GoogleVerifier {
  readonly #keys: JWTVerifyGetKey;

  constructor(
    private readonly clientIds: readonly string[],
    private readonly clock: Clock,
    /** Tests pass a local JWKS; production fetches (and caches) Google's. */
    keys?: JWTVerifyGetKey,
  ) {
    this.#keys = keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), { timeoutDuration: 5_000 });
  }

  /** Throws `GOOGLE_TOKEN_INVALID` for any token that does not verify. */
  async verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const { payload } = await jwtVerify(idToken, this.#keys, {
        algorithms: ['RS256'],
        issuer: GOOGLE_ISSUERS,
        audience: [...this.clientIds],
        currentDate: new Date(this.clock.now()),
        requiredClaims: ['sub', 'email', 'exp', 'iat'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw new AppError('GOOGLE_TOKEN_INVALID');
      }
      return {
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        emailVerified: payload.email_verified === true,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Network failures fetching Google's keys are not the client's fault.
      if (error instanceof errors.JWKSTimeout) {
        throw new AppError('UNAVAILABLE', { detail: 'Google sign-in is unavailable. Try again.' });
      }
      throw new AppError('GOOGLE_TOKEN_INVALID');
    }
  }
}
