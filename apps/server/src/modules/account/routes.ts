/** Account module (minimal in Phase 5): `GET /v1/me`. Profile editing comes in Phase 6. */
import type { FastifyPluginCallback, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { MeResponseSchema, type MeResponse } from '@pingdost/shared-types';

import { AppError } from '../../infra/errors';
import type { RouteLimits } from '../../infra/rate-limits';
import { authOf } from '../auth/guard';
import type { AuthCollections, UserDoc } from '../auth/repo';

export interface AccountRoutesOptions {
  collections: AuthCollections;
  authenticate: preHandlerAsyncHookHandler;
  limits: RouteLimits;
}

export function toMe(user: UserDoc): MeResponse {
  return {
    userId: user._id,
    username: user.username,
    email: user.email,
    status: user.status,
    authProviders: user.authProviders,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    privacy: user.privacy,
    accountIdentityKey: user.accountIdentityKey,
    createdAt: user.createdAt.getTime(),
  };
}

export const accountRoutes: FastifyPluginCallback<AccountRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/me',
    {
      config: { rateLimit: options.limits.me },
      preHandler: options.authenticate,
      schema: { response: { 200: MeResponseSchema } },
    },
    async (request) => {
      const user = await options.collections.users.findOne({ _id: authOf(request).userId });
      if (!user) throw new AppError('UNAUTHENTICATED');
      return toMe(user);
    },
  );
  done();
};
