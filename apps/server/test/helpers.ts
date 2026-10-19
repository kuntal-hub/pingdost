/**
 * Integration-test harness: a real app on its own Mongo database, SMTP to Mailpit, a
 * capturing logger and a clock tests can move forward.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { loadServerConfig, type ServerConfig } from '@pingdost/config';

import { buildApp, setupIndexes, type AppDeps } from '../src/app';
import type { Clock } from '../src/infra/clock';
import { createLogger } from '../src/infra/logger';
import { createMongo, type Mongo } from '../src/infra/mongo';
import { DEFAULT_ROUTE_LIMITS, type RouteLimits } from '../src/infra/rate-limits';
import { createRedisHandle } from '../src/infra/redis';
import { createEmailProvider } from '../src/modules/email';

export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export class TestClock implements Clock {
  offsetMs = 0;
  now(): number {
    return Date.now() + this.offsetMs;
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

/** Every route limit raised so tests are not throttled unless they ask for it. */
export const RELAXED_LIMITS: RouteLimits = Object.fromEntries(
  Object.keys(DEFAULT_ROUTE_LIMITS).map((name) => [name, { max: 100_000, timeWindow: 60_000 }]),
) as RouteLimits;

export interface TestServer {
  app: FastifyInstance;
  config: ServerConfig;
  mongo: Mongo;
  clock: TestClock;
  /** Every log line written so far (JSON). */
  logs: string[];
  close(): Promise<void>;
}

export interface TestServerOptions {
  env?: Record<string, string>;
  routeLimits?: Partial<RouteLimits>;
  throttles?: AppDeps['throttles'];
  googleKeys?: AppDeps['googleKeys'];
  onDeviceRevoked?: AppDeps['onDeviceRevoked'];
  mongo?: Mongo;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const config = loadServerConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    ...(process.env.MONGODB_URI ? { MONGODB_URI: process.env.MONGODB_URI } : {}),
    ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
    ...options.env,
  });
  const logs: string[] = [];
  const logger = createLogger({
    level: config.LOG_LEVEL,
    destination: { write: (line: string) => void logs.push(line) },
  });
  const ownMongo = options.mongo === undefined;
  const mongo =
    options.mongo ??
    createMongo(config.MONGODB_URI, { dbName: `pingdost_test_${randomUUID().slice(0, 8)}` });
  if (ownMongo) await setupIndexes(mongo);
  const redis = createRedisHandle(config.REDIS_URL);
  const email = createEmailProvider(config, logger);
  const clock = new TestClock();
  const app = await buildApp(config, {
    logger,
    mongo,
    redis,
    email,
    clock,
    routeLimits: { ...RELAXED_LIMITS, ...options.routeLimits },
    ...(options.throttles ? { throttles: options.throttles } : {}),
    ...(options.googleKeys ? { googleKeys: options.googleKeys } : {}),
    ...(options.onDeviceRevoked ? { onDeviceRevoked: options.onDeviceRevoked } : {}),
  });
  await app.ready();

  return {
    app,
    config,
    mongo,
    clock,
    logs,
    async close() {
      await app.close();
      if (ownMongo) {
        await mongo.db.dropDatabase();
        await mongo.close();
      }
      await email.close();
      await redis.close();
    },
  };
}

/** A fresh user's registration input. */
export function newUser(): { username: string; email: string; password: string } {
  const id = randomUUID().replaceAll('-', '').slice(0, 12);
  return {
    username: `u_${id}`,
    email: `${id}@test.pingdost.localhost`,
    password: `correct horse ${id}`,
  };
}

export function json<T = Record<string, unknown>>(response: LightMyRequestResponse): T {
  return response.json<T>();
}

interface MailpitSearch {
  messages: { ID: string; Created: string }[];
}

/** The OTP in the newest email to `address`, waiting until `count` emails have arrived. */
export async function otpFor(address: string, count = 1): Promise<string> {
  const query = encodeURIComponent(`to:"${address}"`);
  for (let attempt = 0; attempt < 50; attempt++) {
    const search = (await (
      await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`)
    ).json()) as MailpitSearch;
    const newest = search.messages[0];
    if (search.messages.length >= count && newest) {
      const message = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${newest.ID}`)
      ).json()) as {
        Text: string;
      };
      const code = /\b(\d{6})\b/.exec(message.Text)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no OTP email for ${address}`);
}

/** How many emails Mailpit holds for `address`. */
export async function emailCount(address: string): Promise<number> {
  const query = encodeURIComponent(`to:"${address}"`);
  const search = (await (
    await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`)
  ).json()) as MailpitSearch;
  return search.messages.length;
}

/** Registers and verifies a user; returns the session. */
export async function registeredUser(
  server: TestServer,
  user = newUser(),
): Promise<{
  user: ReturnType<typeof newUser>;
  accessToken: string;
  refreshToken: string;
  userId: string;
}> {
  const registered = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: user,
  });
  if (registered.statusCode !== 201) throw new Error(`register failed: ${registered.body}`);
  const verified = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/email/verify',
    payload: { email: user.email, otp: await otpFor(user.email) },
  });
  if (verified.statusCode !== 200) throw new Error(`verify failed: ${verified.body}`);
  const session = json<{
    user: { userId: string };
    tokens: { accessToken: string; refreshToken: string };
  }>(verified);
  return {
    user,
    userId: session.user.userId,
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
  };
}

export function bearer(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}
