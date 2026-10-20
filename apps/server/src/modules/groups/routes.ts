/** `/v1/groups*` (Phase 13, ADR 0016). Every response is the group after the request. */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  AddGroupMembersRequestSchema,
  ChangeGroupRoleRequestSchema,
  CreateGroupRequestSchema,
  GroupListResponseSchema,
  GroupSchema,
  IdSchema,
} from '@pingdost/shared-types';

import type { GroupService } from './service';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';

export interface GroupRoutesOptions {
  groups: GroupService;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

export const groupRoutes: FastifyPluginCallback<GroupRoutesOptions> = (fastify, options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { groups, authenticate, limits } = options;
  const groupParams = z.object({ groupId: IdSchema });
  const memberParams = z.object({ groupId: IdSchema, userId: IdSchema });

  app.post(
    '/v1/groups',
    {
      config: { rateLimit: limits.groupsCreate },
      preHandler: authenticate,
      schema: { body: CreateGroupRequestSchema, response: { 201: GroupSchema } },
    },
    async (request, reply) => {
      const { groupId, memberUserIds } = request.body;
      const group = await groups.create(authOf(request).userId, groupId, memberUserIds);
      return reply.code(201).send(group);
    },
  );

  app.get(
    '/v1/groups',
    {
      config: { rateLimit: limits.groupsRead },
      preHandler: authenticate,
      schema: { response: { 200: GroupListResponseSchema } },
    },
    async (request) => ({ groups: await groups.list(authOf(request).userId) }),
  );

  app.get(
    '/v1/groups/:groupId',
    {
      config: { rateLimit: limits.groupsRead },
      preHandler: authenticate,
      schema: { params: groupParams, response: { 200: GroupSchema } },
    },
    (request) => groups.get(authOf(request).userId, request.params.groupId),
  );

  app.post(
    '/v1/groups/:groupId/members',
    {
      config: { rateLimit: limits.groupsChange },
      preHandler: authenticate,
      schema: {
        params: groupParams,
        body: AddGroupMembersRequestSchema,
        response: { 200: GroupSchema },
      },
    },
    (request) =>
      groups.addMembers(authOf(request).userId, request.params.groupId, request.body.userIds),
  );

  app.delete(
    '/v1/groups/:groupId/members/:userId',
    {
      config: { rateLimit: limits.groupsChange },
      preHandler: authenticate,
      schema: { params: memberParams, response: { 200: GroupSchema } },
    },
    (request) =>
      groups.removeMember(authOf(request).userId, request.params.groupId, request.params.userId),
  );

  app.patch(
    '/v1/groups/:groupId/members/:userId',
    {
      config: { rateLimit: limits.groupsChange },
      preHandler: authenticate,
      schema: {
        params: memberParams,
        body: ChangeGroupRoleRequestSchema,
        response: { 200: GroupSchema },
      },
    },
    (request) =>
      groups.setRole(
        authOf(request).userId,
        request.params.groupId,
        request.params.userId,
        request.body.role,
      ),
  );

  done();
};
