/** `/v1/blocks*` and `/v1/reports` (Phase 11, ADR 0014). */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  BlockListResponseSchema,
  CreateReportRequestSchema,
  CreateReportResponseSchema,
  IdSchema,
} from '@pingdost/shared-types';

import type { BlockService } from './blocks';
import type { ReportService } from './reports';
import { AppError } from '../../infra/errors';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';
import type { AuthCollections } from '../auth/repo';

export interface SecurityRoutesOptions {
  blocks: BlockService;
  reports: ReportService;
  users: AuthCollections['users'];
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
  /** After a block or unblock between two users (presence). */
  onBlocksChanged?: (blockerUserId: string, blockedUserId: string) => void;
}

export const securityRoutes: FastifyPluginCallback<SecurityRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { blocks, reports, users, authenticate, limits } = options;
  const params = z.object({ userId: IdSchema });

  app.get(
    '/v1/blocks',
    {
      config: { rateLimit: limits.blocksList },
      preHandler: authenticate,
      schema: { response: { 200: BlockListResponseSchema } },
    },
    async (request) => ({ userIds: await blocks.list(authOf(request).userId) }),
  );

  app.put(
    '/v1/blocks/:userId',
    {
      config: { rateLimit: limits.blocksChange },
      preHandler: authenticate,
      schema: { params },
    },
    async (request, reply) => {
      const { userId } = authOf(request);
      const blocked = request.params.userId;
      if (!(await users.countDocuments({ _id: blocked }, { limit: 1 }))) {
        throw new AppError('NOT_FOUND');
      }
      await blocks.block(userId, blocked);
      options.onBlocksChanged?.(userId, blocked);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/v1/blocks/:userId',
    {
      config: { rateLimit: limits.blocksChange },
      preHandler: authenticate,
      schema: { params },
    },
    async (request, reply) => {
      const { userId } = authOf(request);
      await blocks.unblock(userId, request.params.userId);
      options.onBlocksChanged?.(userId, request.params.userId);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/reports',
    {
      config: { rateLimit: limits.reports },
      preHandler: authenticate,
      schema: { body: CreateReportRequestSchema, response: { 201: CreateReportResponseSchema } },
    },
    async (request, reply) => {
      const reportId = await reports.create(authOf(request).userId, request.body);
      return reply.code(201).send({ reportId });
    },
  );

  done();
};
