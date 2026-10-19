/** `GET /v1/ws` (Phase 8). `@fastify/websocket` is registered on the app itself. */
import type { FastifyPluginCallback } from 'fastify';

import { Connection, type GatewayDeps } from './connection';
import type { RouteLimits } from '../../infra/rate-limits';

export interface GatewayRoutesOptions {
  deps: GatewayDeps;
  limits: RouteLimits;
}

export const gatewayRoutes: FastifyPluginCallback<GatewayRoutesOptions> = (
  fastify,
  options,
  done,
) => {
  fastify.get(
    '/v1/ws',
    {
      websocket: true,
      config: {
        rateLimit: {
          ...options.limits.wsConnect,
          // Injected test upgrades have no client IP; real sockets always do.
          keyGenerator: (request) => request.ip || 'unknown',
        },
      },
    },
    (socket) => {
      // Listeners attach synchronously in the constructor, so no early frame is lost.
      new Connection(socket, options.deps);
    },
  );
  done();
};
