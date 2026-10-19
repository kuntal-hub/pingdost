/** `/v1/devices*` routes (Phase 6). */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  DeviceChallengeResponseSchema,
  IdSchema,
  ListDevicesResponseSchema,
  RegisterDeviceRequestSchema,
  RegisterDeviceResponseSchema,
} from '@pingdost/shared-types';

import type { DeviceService } from './service';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';
import { contextOf } from '../auth/routes';

export interface DeviceRoutesOptions {
  service: DeviceService;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

export const deviceRoutes: FastifyPluginCallback<DeviceRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { service, authenticate, limits } = options;

  app.post(
    '/v1/devices/challenge',
    {
      config: { rateLimit: limits.deviceChallenge },
      preHandler: authenticate,
      schema: { response: { 200: DeviceChallengeResponseSchema } },
    },
    async (request) => service.challenge(authOf(request)),
  );

  app.post(
    '/v1/devices',
    {
      config: { rateLimit: limits.deviceRegister },
      preHandler: authenticate,
      schema: {
        body: RegisterDeviceRequestSchema,
        response: { 201: RegisterDeviceResponseSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await service.register(authOf(request), request.body, contextOf(request))),
  );

  app.get(
    '/v1/devices',
    {
      config: { rateLimit: limits.devicesList },
      preHandler: authenticate,
      schema: { response: { 200: ListDevicesResponseSchema } },
    },
    async (request) => ({ devices: await service.list(authOf(request).userId) }),
  );

  app.delete(
    '/v1/devices/:deviceId',
    {
      config: { rateLimit: limits.deviceRevoke },
      preHandler: authenticate,
      schema: { params: z.object({ deviceId: IdSchema }) },
    },
    async (request, reply) => {
      await service.revoke(authOf(request), request.params.deviceId, contextOf(request));
      return reply.code(204).send();
    },
  );

  done();
};
