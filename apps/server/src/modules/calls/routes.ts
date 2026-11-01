/**
 * `GET /v1/calls/turn-credentials` (Phase 25, ADR 0028): STUN and short-lived TURN credentials
 * for the calling device. Nothing about the call is stored; the server keeps no call records
 * (REQ §5.2). Rate-limited per IP.
 */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { TurnCredentialsResponseSchema } from '@pingdost/shared-types';

import { iceServersFor, type TurnSettings } from './turn';
import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';

export interface CallRoutesOptions {
  settings: TurnSettings;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
  clock: Clock;
}

export const callRoutes: FastifyPluginCallback<CallRoutesOptions> = (fastify, options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { settings, authenticate, limits, clock } = options;

  app.get(
    '/v1/calls/turn-credentials',
    {
      config: { rateLimit: limits.turnCredentials },
      preHandler: authenticate,
      schema: { response: { 200: TurnCredentialsResponseSchema } },
    },
    async (request, reply) => {
      const { userId, deviceId } = authOf(request);
      if (!deviceId) throw new AppError('DEVICE_REQUIRED');
      // Credentials are per-user secrets for a while: never cached by anything in between.
      void reply.header('cache-control', 'no-store');
      return iceServersFor(settings, userId, clock.now());
    },
  );

  done();
};
