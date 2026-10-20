/** `PUT|DELETE /v1/push/token` (Phase 12, ADR 0015): the calling device's wake address. */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { PushTokenRequestSchema } from '@pingdost/shared-types';

import type { PushTokens } from './repo';
import { AppError } from '../../infra/errors';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';

export interface PushRoutesOptions {
  tokens: PushTokens;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

export const pushRoutes: FastifyPluginCallback<PushRoutesOptions> = (fastify, options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { tokens, authenticate, limits } = options;

  app.put(
    '/v1/push/token',
    {
      config: { rateLimit: limits.pushToken },
      preHandler: authenticate,
      schema: { body: PushTokenRequestSchema },
    },
    async (request, reply) => {
      const { userId, deviceId } = authOf(request);
      if (!deviceId) throw new AppError('DEVICE_REQUIRED');
      await tokens.put(userId, deviceId, request.body);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/v1/push/token',
    { config: { rateLimit: limits.pushToken }, preHandler: authenticate },
    async (request, reply) => {
      const { deviceId } = authOf(request);
      if (!deviceId) throw new AppError('DEVICE_REQUIRED');
      await tokens.delete(deviceId);
      return reply.code(204).send();
    },
  );

  done();
};
