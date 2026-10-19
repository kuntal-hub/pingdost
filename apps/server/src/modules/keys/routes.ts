/** `/v1/keys/*` routes (Phase 6). */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  ClaimKeysRequestSchema,
  ClaimKeysResponseSchema,
  DeviceOwnerResponseSchema,
  IdSchema,
  OneTimeKeyCountSchema,
  UploadKeysRequestSchema,
  UserKeysResponseSchema,
} from '@pingdost/shared-types';

import type { KeyService } from './service';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';

export interface KeyRoutesOptions {
  service: KeyService;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

export const keyRoutes: FastifyPluginCallback<KeyRoutesOptions> = (fastify, options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { service, authenticate, limits } = options;

  app.post(
    '/v1/keys/otks',
    {
      config: { rateLimit: limits.keysUpload },
      preHandler: authenticate,
      schema: { body: UploadKeysRequestSchema, response: { 200: OneTimeKeyCountSchema } },
    },
    async (request) => ({ count: await service.upload(authOf(request), request.body) }),
  );

  app.get(
    '/v1/keys/otks/count',
    {
      config: { rateLimit: limits.keysCount },
      preHandler: authenticate,
      schema: { response: { 200: OneTimeKeyCountSchema } },
    },
    async (request) => ({ count: await service.count(authOf(request)) }),
  );

  app.get(
    '/v1/keys/users/:userId',
    {
      config: { rateLimit: limits.keysDirectory },
      preHandler: authenticate,
      schema: { params: z.object({ userId: IdSchema }), response: { 200: UserKeysResponseSchema } },
    },
    async (request) => service.directory(request.params.userId),
  );

  app.get(
    '/v1/keys/devices/:deviceId',
    {
      config: { rateLimit: limits.keysDirectory },
      preHandler: authenticate,
      schema: {
        params: z.object({ deviceId: IdSchema }),
        response: { 200: DeviceOwnerResponseSchema },
      },
    },
    async (request) => service.deviceOwner(request.params.deviceId),
  );

  app.post(
    '/v1/keys/claim',
    {
      config: { rateLimit: limits.keysClaim },
      preHandler: authenticate,
      schema: { body: ClaimKeysRequestSchema, response: { 200: ClaimKeysResponseSchema } },
    },
    async (request) => service.claim(authOf(request), request.body.deviceIds),
  );

  done();
};
