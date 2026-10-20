/** `/v1/pairing/*` routes (Phase 16, ADR 0019). Creating, polling and completing are open (IP rate-limited); inspecting and approving need the primary phone's session. */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  ApprovePairingRequestSchema,
  CompletePairingRequestSchema,
  CompletePairingResponseSchema,
  CreatePairingRequestSchema,
  CreatePairingResponseSchema,
  IdSchema,
  InspectPairingRequestSchema,
  InspectPairingResponseSchema,
  PAIRING_SECRET_HEADER,
  PairingStatusResponseSchema,
} from '@pingdost/shared-types';

import type { PairingService } from './service';
import { AppError } from '../../infra/errors';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';
import { contextOf } from '../auth/routes';

export interface PairingRoutesOptions {
  service: PairingService;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

const Params = z.object({ pairingId: IdSchema });

export const pairingRoutes: FastifyPluginCallback<PairingRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { service, authenticate, limits } = options;

  app.post(
    '/v1/pairing/requests',
    {
      config: { rateLimit: limits.pairingCreate },
      schema: { body: CreatePairingRequestSchema, response: { 201: CreatePairingResponseSchema } },
    },
    async (request, reply) =>
      reply.code(201).send(await service.create(request.body, contextOf(request))),
  );

  app.get(
    '/v1/pairing/requests/:pairingId',
    {
      config: { rateLimit: limits.pairingPoll },
      schema: { params: Params, response: { 200: PairingStatusResponseSchema } },
    },
    async (request) => {
      const secret = request.headers[PAIRING_SECRET_HEADER];
      if (typeof secret !== 'string' || secret === '') throw new AppError('PAIRING_NOT_FOUND');
      return service.status(request.params.pairingId, secret);
    },
  );

  app.post(
    '/v1/pairing/requests/:pairingId/complete',
    {
      config: { rateLimit: limits.pairingComplete },
      schema: {
        params: Params,
        body: CompletePairingRequestSchema,
        response: { 201: CompletePairingResponseSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await service.complete(request.params.pairingId, request.body, contextOf(request))),
  );

  app.post(
    '/v1/pairing/inspect',
    {
      config: { rateLimit: limits.pairingInspect },
      preHandler: authenticate,
      schema: {
        body: InspectPairingRequestSchema,
        response: { 200: InspectPairingResponseSchema },
      },
    },
    async (request) => service.inspect(authOf(request), request.body),
  );

  app.post(
    '/v1/pairing/approve',
    {
      config: { rateLimit: limits.pairingApprove },
      preHandler: authenticate,
      schema: { body: ApprovePairingRequestSchema },
    },
    async (request, reply) => {
      await service.approve(authOf(request), request.body, contextOf(request));
      return reply.code(204).send();
    },
  );

  done();
};
