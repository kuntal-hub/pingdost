/** `/v1/devices/primary-transfer*` and `/v1/devices/primary-replace*` (Phase 19, ADR 0022). */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  ApprovePrimaryTransferRequestSchema,
  CompletePrimaryTransferRequestSchema,
  IdSchema,
  ListPrimaryTransfersResponseSchema,
  PrimaryTransferStatusResponseSchema,
  RegisterDeviceResponseSchema,
  ReplacePrimaryRequestSchema,
  StartPrimaryTransferRequestSchema,
  StartPrimaryTransferResponseSchema,
} from '@pingdost/shared-types';

import type { PrimaryTransferService } from './primary-transfer';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';
import { contextOf } from '../auth/routes';

export interface PrimaryTransferRoutesOptions {
  service: PrimaryTransferService;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

const params = z.object({ requestId: IdSchema });

export const primaryTransferRoutes: FastifyPluginCallback<PrimaryTransferRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { service, authenticate, limits } = options;

  app.post(
    '/v1/devices/primary-transfer',
    {
      config: { rateLimit: limits.transferStart },
      preHandler: authenticate,
      schema: {
        body: StartPrimaryTransferRequestSchema,
        response: { 201: StartPrimaryTransferResponseSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.start(authOf(request), request.body, contextOf(request))),
  );

  app.get(
    '/v1/devices/primary-transfer',
    {
      config: { rateLimit: limits.transferList },
      preHandler: authenticate,
      schema: { response: { 200: ListPrimaryTransfersResponseSchema } },
    },
    async (request) => service.pending(authOf(request)),
  );

  app.get(
    '/v1/devices/primary-transfer/:requestId',
    {
      config: { rateLimit: limits.transferPoll },
      preHandler: authenticate,
      schema: { params, response: { 200: PrimaryTransferStatusResponseSchema } },
    },
    async (request) => service.status(authOf(request), request.params.requestId),
  );

  app.post(
    '/v1/devices/primary-transfer/:requestId/approve',
    {
      config: { rateLimit: limits.transferDecide },
      preHandler: authenticate,
      schema: { params, body: ApprovePrimaryTransferRequestSchema },
    },
    async (request, reply) => {
      await service.approve(
        authOf(request),
        request.params.requestId,
        request.body,
        contextOf(request),
      );
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/devices/primary-transfer/:requestId/deny',
    {
      config: { rateLimit: limits.transferDecide },
      preHandler: authenticate,
      schema: { params },
    },
    async (request, reply) => {
      await service.deny(authOf(request), request.params.requestId, contextOf(request));
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/devices/primary-transfer/:requestId/complete',
    {
      config: { rateLimit: limits.transferComplete },
      preHandler: authenticate,
      schema: {
        params,
        body: CompletePrimaryTransferRequestSchema,
        response: { 201: RegisterDeviceResponseSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.complete(
            authOf(request),
            request.params.requestId,
            request.body,
            contextOf(request),
          ),
        ),
  );

  app.post(
    '/v1/devices/primary-replace/otp',
    { config: { rateLimit: limits.replaceOtp }, preHandler: authenticate },
    async (request, reply) => {
      await service.sendReplaceOtp(authOf(request));
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/devices/primary-replace',
    {
      config: { rateLimit: limits.replace },
      preHandler: authenticate,
      schema: {
        body: ReplacePrimaryRequestSchema,
        response: { 201: RegisterDeviceResponseSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await service.replace(authOf(request), request.body, contextOf(request))),
  );

  done();
};
