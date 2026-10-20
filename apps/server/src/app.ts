/**
 * The Fastify modular monolith (ARCHITECTURE A2). `buildApp` only wires plugins: the caller
 * owns the dependencies (Mongo, Redis, email, logger) and closes them after `app.close()`.
 */
import { randomUUID } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';

import type { ServerConfig } from '@pingdost/config';
import { limitsFor } from '@pingdost/protocol';
import type { PushProvider } from '@pingdost/shared-types';

import { systemClock, type Clock } from './infra/clock';
import { AppError, registerErrorHandling } from './infra/errors';
import { Metrics } from './infra/metrics';
import { ensureIndexes, type IndexSetup, type Mongo } from './infra/mongo';
import { DEFAULT_ROUTE_LIMITS, type RouteLimits } from './infra/rate-limits';
import type { RedisHandle } from './infra/redis';
import { schedulerIndexes } from './infra/scheduler';
import { Hasher } from './infra/secrets';
import { DEFAULT_THROTTLES, type ThrottleSettings } from './infra/throttles';
import { accountRoutes } from './modules/account/routes';
import { createAttachmentService } from './modules/attachments';
import { attachmentRoutes } from './modules/attachments/routes';
import { attachmentIndexes, type AttachmentSettings } from './modules/attachments/service';
import type { AttachmentStore } from './modules/attachments/store/types';
import { GoogleVerifier } from './modules/auth/google';
import { createAuthGuard } from './modules/auth/guard';
import { PasswordHasher } from './modules/auth/passwords';
import { authCollections, authIndexes } from './modules/auth/repo';
import { authRoutes } from './modules/auth/routes';
import { AuthService } from './modules/auth/service';
import { AccessTokens } from './modules/auth/tokens';
import {
  MongoMailbox,
  pendingEnvelopeIndexes,
  type MongoMailboxStore,
} from './modules/delivery/mongo-store';
import { RedisMailbox } from './modules/delivery/redis-store';
import { DeliveryService } from './modules/delivery/service';
import { mailboxSettings, type MailboxSettings } from './modules/delivery/settings';
import { deviceCollections, deviceIndexes } from './modules/device/repo';
import { deviceRoutes } from './modules/device/routes';
import { DeviceService, type DeviceRevokedHook } from './modules/device/service';
import type { EmailProvider } from './modules/email';
import {
  DEFAULT_GATEWAY_SETTINGS,
  type Connection,
  type GatewaySettings,
} from './modules/gateway/connection';
import { PresenceHub } from './modules/gateway/presence';
import { ConnectionRegistry } from './modules/gateway/registry';
import { gatewayRoutes } from './modules/gateway/routes';
import { groupRoutes } from './modules/groups/routes';
import { groupIndexes, GroupService } from './modules/groups/service';
import { metricsRoutes } from './modules/health/metrics-routes';
import { healthRoutes } from './modules/health/routes';
import { keyIndexes, oneTimeKeys } from './modules/keys/repo';
import { keyRoutes } from './modules/keys/routes';
import { KeyService } from './modules/keys/service';
import { createPushSenders } from './modules/push';
import { noopPushNotifier, type PushNotifier, type PushSender } from './modules/push/notifier';
import { pushTokenIndexes, PushTokens } from './modules/push/repo';
import { pushRoutes } from './modules/push/routes';
import { PushService } from './modules/push/service';
import { blockIndexes, BlockService } from './modules/security/blocks';
import { securityEventIndexes, SecurityEvents } from './modules/security/events';
import { reportIndexes, ReportService } from './modules/security/reports';
import { securityRoutes } from './modules/security/routes';

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
  /** Extra hooks after a revocation (the gateway's `Revoked` push is always registered). */
  onDeviceRevoked?: DeviceRevokedHook[];
  /** Shared with the in-process jobs (`createAppMetrics`); created here when absent. */
  metrics?: Metrics;
  /** Replaces the wake scheduler entirely (tests); otherwise `PushService` is used. */
  push?: PushNotifier;
  /** Replaces the configured FCM / Web Push senders (tests with fake providers). */
  pushSenders?: Partial<Record<PushProvider, PushSender>>;
  /** Test overrides: mailbox timings and a replacement Mongo store. */
  delivery?: { settings?: Partial<MailboxSettings>; mongoStore?: MongoMailboxStore };
  gateway?: Partial<GatewaySettings>;
  /** Test overrides: another staging store (e.g. a temp directory) and settings. */
  attachments?: { store?: AttachmentStore; settings?: Partial<AttachmentSettings> };
}

/** Every module's indexes. `main.ts` and `worker.ts` create them at startup. */
export const INDEXES: readonly IndexSetup[] = [
  authIndexes,
  deviceIndexes,
  keyIndexes,
  pendingEnvelopeIndexes,
  securityEventIndexes,
  blockIndexes,
  reportIndexes,
  pushTokenIndexes,
  groupIndexes,
  attachmentIndexes,
  schedulerIndexes,
];

export function setupIndexes(mongo: Mongo): Promise<void> {
  return ensureIndexes(mongo.db, INDEXES);
}

/** The metrics registry, reading Redis usage and the Mongo mailbox on each scrape. */
export function createAppMetrics(
  redis: RedisHandle,
  mongo: Mongo,
  clock: Clock = systemClock,
): Metrics {
  const mailbox = new MongoMailbox(mongo.db);
  return new Metrics({
    redisCommands: () => redis.commandCount(),
    mongoMailbox: () => mailbox.stats(clock.now()),
  });
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

  const mailbox: MailboxSettings = { ...mailboxSettings(config), ...deps.delivery?.settings };
  await app.register(websocket, {
    options: { maxPayload: limitsFor({ envelopeMaxBytes: mailbox.envelopeMaxBytes }).frame },
  });

  const { db } = deps.mongo;
  const metrics = deps.metrics ?? createAppMetrics(deps.redis, deps.mongo, clock);
  const registry = new ConnectionRegistry<Connection>();
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
  const pushTokens = new PushTokens(db, clock);
  const pushService = deps.push
    ? undefined
    : new PushService({
        tokens: pushTokens,
        senders: deps.pushSenders ?? createPushSenders(config, clock),
        throttleMs: config.PUSH_WAKE_THROTTLE_SECONDS * 1_000,
        clock,
        metrics,
        log: deps.logger,
        isConnected: (deviceId) => registry.get(deviceId) !== undefined,
      });
  if (pushService) app.addHook('onClose', () => pushService.close());
  const deviceService = new DeviceService({
    devices,
    auth: collections,
    oneTimeKeys: otks,
    authService,
    events,
    clock,
    onRevoked: [
      (deviceId) => registry.get(deviceId)?.revoke(clock.now()),
      (deviceId) =>
        void pushTokens
          .delete(deviceId)
          .catch((error: unknown) => deps.logger.warn({ err: error }, 'push token delete failed')),
      ...(deps.onDeviceRevoked ?? []),
    ],
  });
  const keyService = new KeyService({
    auth: collections,
    devices,
    oneTimeKeys: otks,
    clock,
    claimBudget: throttles.keyClaims,
    onClaimed: (deviceIds) => {
      for (const deviceId of deviceIds) {
        void registry
          .get(deviceId)
          ?.checkKeys()
          .catch((error: unknown) => deps.logger.warn({ err: error }, 'key check failed'));
      }
    },
  });
  const blocks = new BlockService(db, clock);
  const groups = new GroupService({
    db,
    users: collections.users,
    clock,
    maxMembers: config.GROUP_MAX_MEMBERS,
    onChanged: (groupId, version, userIds) => {
      for (const userId of userIds) {
        for (const connection of registry.forUser(userId)) {
          connection.notifyGroupChanged(groupId, version);
        }
      }
    },
  });
  const reports = new ReportService(
    db,
    collections.users,
    config.ABUSE_REPORT_RETENTION_SECONDS,
    clock,
  );
  const delivery = new DeliveryService({
    settings: mailbox,
    clock,
    metrics,
    log: deps.logger,
    redis: new RedisMailbox(deps.redis, mailbox.redisKeyPrefix),
    mongo: deps.delivery?.mongoStore ?? new MongoMailbox(db),
    activeDeviceOwner: async (deviceId) =>
      (
        await devices.devices.findOne(
          { _id: deviceId, status: 'active' },
          { projection: { userId: 1 } },
        )
      )?.userId,
    isBlocked: (blockerUserId, userId) => blocks.isBlocked(blockerUserId, userId),
    isGroupMember: (groupId, userId) => groups.isMember(groupId, userId),
  });
  const presence = new PresenceHub<Connection>({
    sharesPresence: async (userId) =>
      (await collections.users.findOne({ _id: userId }, { projection: { privacy: 1 } }))?.privacy
        .lastSeen ?? false,
    blocked: (a, b) => blocks.eitherBlocked(a, b),
    now: () => clock.now(),
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
    onPrivacyChanged: (userId) => presence.invalidate(userId),
  });
  await app.register(deviceRoutes, { service: deviceService, authenticate, limits });
  await app.register(keyRoutes, { service: keyService, authenticate, limits });
  await app.register(securityRoutes, {
    blocks,
    reports,
    users: collections.users,
    authenticate,
    limits,
    onBlocksChanged: (a, b) => void presence.blocksChanged(a, b).catch(() => undefined),
  });
  await app.register(pushRoutes, { tokens: pushTokens, authenticate, limits });
  await app.register(groupRoutes, { groups, authenticate, limits });
  const attachments = createAttachmentService(config, {
    db,
    clock,
    metrics,
    log: deps.logger,
    ...(deps.attachments?.store ? { store: deps.attachments.store } : {}),
    ...(deps.attachments?.settings ? { settings: deps.attachments.settings } : {}),
  });
  metrics.attachmentStats = () => attachments.service.stats();
  await app.register(attachmentRoutes, {
    attachments: attachments.service,
    signer: attachments.signer,
    authenticate,
    limits,
    clock,
  });
  await app.register(gatewayRoutes, {
    limits,
    deps: {
      settings: { ...DEFAULT_GATEWAY_SETTINGS, ...deps.gateway },
      mailbox,
      clock,
      metrics,
      log: deps.logger,
      tokens,
      sessions: collections.sessions,
      devices: devices.devices,
      oneTimeKeys: otks,
      delivery,
      push: deps.push ?? pushService ?? noopPushNotifier,
      registry,
      presence,
      blocks,
    },
  });
  await app.register(metricsRoutes, { metrics, token: config.METRICS_TOKEN, limits });

  return app;
}
