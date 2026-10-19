/**
 * The `authenticate` preHandler: verifies the bearer access token, then that its session is
 * still active (logout, password reset and refresh-token reuse revoke sessions immediately).
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import type { AuthCollections } from './repo';
import type { AccessTokens } from './tokens';
import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';

export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function createAuthGuard(
  tokens: AccessTokens,
  collections: AuthCollections,
  clock: Clock,
): preHandlerAsyncHookHandler {
  return async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw new AppError('UNAUTHENTICATED');

    const claims = await tokens.verify(token);
    const session = await collections.sessions.findOne(
      {
        _id: claims.sessionId,
        userId: claims.userId,
        revokedAt: null,
        expiresAt: { $gt: new Date(clock.now()) },
      },
      { projection: { deviceId: 1 } },
    );
    if (!session) throw new AppError('UNAUTHENTICATED');
    request.auth = { ...claims, deviceId: session.deviceId };
  };
}

/** The caller's identity on a route behind the guard. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError('UNAUTHENTICATED');
  return request.auth;
}
