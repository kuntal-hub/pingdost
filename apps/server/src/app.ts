/**
 * The Fastify modular monolith (ARCHITECTURE A2). `buildApp` only wires plugins: the caller
 * owns the dependencies (Mongo, Redis, email, logger) and closes them after `app.close()`.
 */
import { randomUUID } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';

import type { ServerConfig } from '@pingdost/config';

import { systemClock, type Clock } from './infra/clock';
import { AppError, registerErrorHandling } from './infra/errors';
import { ensureIndexes, type IndexSetup, type Mongo } from './infra/mongo';
import { DEFAULT_ROUTE_LIMITS, type RouteLimits } from './infra/rate-limits';
import type { RedisHandle } from './infra/redis';
import { schedulerIndexes } from './infra/scheduler';
import { Hasher } from './infra/secrets';
import { DEFAULT_THROTTLES, type ThrottleSettings } from './infra/throttles';
import { accountRoutes } from './modules/account/routes';
import { GoogleVerifier } from './modules/auth/google';
import { createAuthGuard } from './modules/auth/guard';
import { PasswordHasher } from './modules/auth/passwords';
import { authCollections, authIndexes } from './modules/auth/repo';
import { authRoutes } from './modules/auth/routes';
import { AuthService } from './modules/auth/service';
import { AccessTokens } from './modules/auth/tokens';
import { deviceCollections, deviceIndexes } from './modules/device/repo';
import { deviceRoutes } from './modules/device/routes';
import { DeviceService, type DeviceRevokedHook } from './modules/device/service';
import type { EmailProvider } from './modules/email';
import { healthRoutes } from './modules/health/routes';
import { keyIndexes, oneTimeKeys } from './modules/keys/repo';
import { keyRoutes } from './modules/keys/routes';
import { KeyService } from './modules/keys/service';
import { securityEventIndexes, SecurityEvents } from './modules/security/events';

export interface AppDeps {
  logger: Logger;
  mongo: Mongo;
  redis: RedisHandle;
  email: EmailProvider;
  clock?: Clock;
  /** Overrides for tests; production uses the defaults. */
  routeLimits?: Partial<RouteLimits>;
  throttles?: Partial<ThrottleSettings>;
  /** Google's signing keys; tests pass a local JWKS. */
  googleKeys?: JWTVerifyGetKey;
  /** Phase 8 registers the WS `Revoked` push here. */
  onDeviceRevoked?: DeviceRevokedHook[];
}

/** Every module's indexes. `main.ts` and `worker.ts` create them at startup. */
export const INDEXES: readonly IndexSetup[] = [
  authIndexes,
  deviceIndexes,
  keyIndexes,
  securityEventIndexes,
  schedulerIndexes,
];

export function setupIndexes(mongo: Mongo): Promise<void> {
  return ensureIndexes(mongo.db, INDEXES);
}

export async function buildApp(config: ServerConfig, deps: AppDeps): Promise<FastifyInstance> {
  const clock = deps.clock ?? systemClock;
  const limits: RouteLimits = { ...DEFAULT_ROUTE_LIMITS, ...deps.routeLimits };
  const throttles: ThrottleSettings = { ...DEFAULT_THROTTLES, ...deps.throttles };
  // Typed as Fastify's base logger so the instance type matches plugin signatures.
  const baseLogger: FastifyBaseLogger = deps.logger;

  const app = Fastify({
    loggerInstance: baseLogger,
    trustProxy: config.TRUST_PROXY,
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      new AppError('RATE_LIMITED', {
        retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
      }),
  });

  const { db } = deps.mongo;
  const hasher = new Hasher(config.SERVER_HMAC_PEPPER);
  const collections = authCollections(db);
  const devices = deviceCollections(db);
  const otks = oneTimeKeys(db);
  const tokens = new AccessTokens(
    config.ACCESS_TOKEN_SIGNING_KEY,
    config.ACCESS_TOKEN_TTL_SECONDS,
    clock,
  );
  const events = new SecurityEvents(
    db,
    hasher,
    config.SECURITY_EVENT_RETENTION_SECONDS,
    clock,
    deps.logger,
  );
  const authService = new AuthService({
    config,
    collections,
    passwords: new PasswordHasher({
      memoryKib: config.ARGON2_MEMORY_KIB,
      iterations: config.ARGON2_ITERATIONS,
      parallelism: config.ARGON2_PARALLELISM,
    }),
    tokens,
    hasher,
    email: deps.email,
    events,
    clock,
    log: deps.logger,
    throttles,
    google: config.google
      ? new GoogleVerifier(config.google.clientIds, clock, deps.googleKeys)
      : undefined,
  });
  const deviceService = new DeviceService({
    devices,
    auth: collections,
    oneTimeKeys: otks,
    authService,
    events,
    clock,
    ...(deps.onDeviceRevoked ? { onRevoked: deps.onDeviceRevoked } : {}),
  });
  const keyService = new KeyService({
    auth: collections,
    devices,
    oneTimeKeys: otks,
    clock,
    claimBudget: throttles.keyClaims,
  });
  const authenticate = createAuthGuard(tokens, collections, clock, (deviceId) =>
    deviceService.touch(deviceId),
  );

  await app.register(healthRoutes, { mongo: deps.mongo, redis: deps.redis });
  await app.register(authRoutes, { service: authService, authenticate, limits });
  await app.register(accountRoutes, {
    collections,
    authenticate,
    limits,
    clock,
    lookupBudget: throttles.usernameLookups,
    cloudinary: config.cloudinary,
  });
  await app.register(deviceRoutes, { service: deviceService, authenticate, limits });
  await app.register(keyRoutes, { service: keyService, authenticate, limits });

  return app;
}
