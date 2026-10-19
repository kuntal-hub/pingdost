/**
 * Access tokens (ARCHITECTURE A2): HS256 JWTs (`jose`) with `sub` (userId) and `sid`
 * (session); Phase 6 adds `did` (device). Default TTL 15 minutes.
 */
import { errors, jwtVerify, SignJWT } from 'jose';

import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';

const ISSUER = 'pingdost';
const AUDIENCE = 'pingdost-api';

export interface AccessClaims {
  userId: string;
  sessionId: string;
  /** The `did` claim, once the session is bound to a device. */
  deviceId?: string | null;
}

export class AccessTokens {
  readonly #key: Uint8Array;

  constructor(
    signingKeyBase64: string,
    private readonly ttlSeconds: number,
    private readonly clock: Clock,
  ) {
    this.#key = Buffer.from(signingKeyBase64, 'base64');
  }

  async sign(claims: AccessClaims): Promise<{ token: string; expiresAt: number }> {
    const issuedAt = Math.floor(this.clock.now() / 1000);
    const expiresAtSeconds = issuedAt + this.ttlSeconds;
    const token = await new SignJWT({
      sid: claims.sessionId,
      ...(claims.deviceId ? { did: claims.deviceId } : {}),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.#key);
    return { token, expiresAt: expiresAtSeconds * 1000 };
  }

  /** Throws `TOKEN_EXPIRED` for an expired token and `UNAUTHENTICATED` for anything else. */
  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: new Date(this.clock.now()),
        requiredClaims: ['sub', 'exp'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new AppError('UNAUTHENTICATED');
      }
      return {
        userId: payload.sub,
        sessionId: payload.sid,
        deviceId: typeof payload.did === 'string' ? payload.did : null,
      };
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw new AppError('TOKEN_EXPIRED');
      if (error instanceof AppError) throw error;
      throw new AppError('UNAUTHENTICATED');
    }
  }
}
