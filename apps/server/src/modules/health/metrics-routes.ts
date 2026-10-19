/**
 * `GET /metrics` (Prometheus text) behind `Authorization: Bearer <METRICS_TOKEN>`. Without a
 * configured token the route answers 404, as if it did not exist.
 */
import { timingSafeEqual } from 'node:crypto';

import type { FastifyPluginCallback } from 'fastify';

import { AppError } from '../../infra/errors';
import type { Metrics } from '../../infra/metrics';
import type { RouteLimits } from '../../infra/rate-limits';

export interface MetricsRoutesOptions {
  metrics: Metrics;
  token: string | undefined;
  limits: RouteLimits;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const metricsRoutes: FastifyPluginCallback<MetricsRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  const { metrics, token, limits } = options;
  fastify.get('/metrics', { config: { rateLimit: limits.metrics } }, async (request, reply) => {
    if (!token) throw new AppError('NOT_FOUND');
    const header = request.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!sameSecret(given, token)) throw new AppError('UNAUTHENTICATED');
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
  done();
};
