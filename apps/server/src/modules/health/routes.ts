/** `/healthz` (the process is up) and `/readyz` (its dependencies answer). Not rate-limited. */
import type { FastifyPluginCallback } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  HEALTH_PATH,
  HealthResponseSchema,
  READY_PATH,
  ReadyResponseSchema,
} from '@pingdost/shared-types';

import type { Mongo } from '../../infra/mongo';
import type { RedisHandle } from '../../infra/redis';

export interface HealthRoutesOptions {
  mongo: Mongo;
  redis: RedisHandle;
}

export const healthRoutes: FastifyPluginCallback<HealthRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(HEALTH_PATH, { schema: { response: { 200: HealthResponseSchema } } }, () => ({
    status: 'ok' as const,
  }));

  app.get(
    READY_PATH,
    { schema: { response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema } } },
    async (_request, reply) => {
      const checks: Record<string, 'ok' | 'fail'> = {
        mongo: (await options.mongo.ping()) ? 'ok' : 'fail',
      };
      // Redis is checked once something uses it (the mailbox, from Phase 8).
      if (options.redis.used) checks.redis = (await options.redis.ping()) ? 'ok' : 'fail';
      const ready = Object.values(checks).every((check) => check === 'ok');
      return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
    },
  );
  done();
};
