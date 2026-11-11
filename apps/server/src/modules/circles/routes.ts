/** `/v1/circle*` (Phase 37, ADR 0041). */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  CircleRequestsResponseSchema,
  CircleResponseSchema,
  IdSchema,
  SendCircleRequestResponseSchema,
  SendCircleRequestSchema,
} from '@pingdost/shared-types';

import type { CircleService } from './service';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';

export interface CircleRoutesOptions {
  circles: CircleService;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

export const circleRoutes: FastifyPluginCallback<CircleRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { circles, authenticate, limits } = options;
  const params = z.object({ userId: IdSchema });

  app.get(
    '/v1/circle',
    {
      config: { rateLimit: limits.circleRead },
      preHandler: authenticate,
      schema: { response: { 200: CircleResponseSchema } },
    },
    async (request) => ({ members: await circles.list(authOf(request).userId) }),
  );

  app.delete(
    '/v1/circle/:userId',
    {
      config: { rateLimit: limits.circleChange },
      preHandler: authenticate,
      schema: { params },
    },
    async (request, reply) => {
      await circles.remove(authOf(request).userId, request.params.userId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/v1/circle/requests',
    {
      config: { rateLimit: limits.circleRead },
      preHandler: authenticate,
      schema: { response: { 200: CircleRequestsResponseSchema } },
    },
    (request) => circles.requests(authOf(request).userId),
  );

  app.post(
    '/v1/circle/requests',
    {
      config: { rateLimit: limits.circleChange },
      preHandler: authenticate,
      schema: { body: SendCircleRequestSchema, response: { 200: SendCircleRequestResponseSchema } },
    },
    async (request) => ({
      status: await circles.request(authOf(request).userId, request.body.userId),
    }),
  );

  app.post(
    '/v1/circle/requests/:userId/accept',
    {
      config: { rateLimit: limits.circleChange },
      preHandler: authenticate,
      schema: { params },
    },
    async (request, reply) => {
      await circles.accept(authOf(request).userId, request.params.userId);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/circle/requests/:userId/decline',
    {
      config: { rateLimit: limits.circleChange },
      preHandler: authenticate,
      schema: { params },
    },
    async (request, reply) => {
      await circles.decline(authOf(request).userId, request.params.userId);
      return reply.code(204).send();
    },
  );

  /** Withdraws this user's own request to `userId`. */
  app.delete(
    '/v1/circle/requests/:userId',
    {
      config: { rateLimit: limits.circleChange },
      preHandler: authenticate,
      schema: { params },
    },
    async (request, reply) => {
      await circles.withdraw(authOf(request).userId, request.params.userId);
      return reply.code(204).send();
    },
  );

  done();
};
