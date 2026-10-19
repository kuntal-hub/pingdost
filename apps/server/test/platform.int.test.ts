/** Health, problem+json, rate limits, log redaction, security events and the API client. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authApi, createApiClient } from '@pingdost/api-client';

import { json, newUser, otpFor, registeredUser, startTestServer, type TestServer } from './helpers';
import { createMongo } from '../src/infra/mongo';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    const live = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(json(live)).toEqual({ status: 'ok' });
    const ready = await server.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(json(ready)).toEqual({ status: 'ok', checks: { mongo: 'ok' } });
  });

  it('reports not ready, quickly, when Mongo is unreachable', async () => {
    const down = createMongo('mongodb://127.0.0.1:1/pingdost', { serverSelectionTimeoutMS: 300 });
    const isolated = await startTestServer({ mongo: down });
    try {
      const started = Date.now();
      const ready = await isolated.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(json(ready)).toEqual({ status: 'unavailable', checks: { mongo: 'fail' } });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect((await isolated.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await isolated.close();
      await down.close();
    }
  });
});

describe('errors', () => {
  it('answers unknown routes with problem+json', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(json(response)).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('maps malformed JSON to VALIDATION_FAILED and sets a request ID', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"identifier":',
    });
    expect(response.statusCode).toBe(400);
    expect(json(response)).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('rate limits', () => {
  it('answers 429 RATE_LIMITED with Retry-After once a route budget is spent', async () => {
    const limited = await startTestServer({
      routeLimits: { login: { max: 2, timeWindow: 60_000 } },
    });
    try {
      const attempt = () =>
        limited.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { identifier: 'someone', password: 'whatever' },
        });
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      const third = await attempt();
      expect(third.statusCode).toBe(429);
      expect(third.headers['content-type']).toContain('application/problem+json');
      expect(json(third)).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it('limits OTP emails per address, whatever the client IP', async () => {
    const limited = await startTestServer({
      authThrottles: {
        loginFailures: { limit: 5, windowMs: 60_000 },
        otpSends: { limit: 1, windowMs: 3_600_000 },
        otpChecks: { limit: 15, windowMs: 3_600_000 },
      },
    });
    try {
      const user = newUser();
      await limited.app.inject({ method: 'POST', url: '/v1/auth/register', payload: user });
      limited.clock.advance(31_000);
      const resend = await limited.app.inject({
        method: 'POST',
        url: '/v1/auth/email/resend',
        payload: { email: user.email },
        remoteAddress: '203.0.113.9',
      });
      expect(json(resend)).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await limited.close();
    }
  });
});

describe('privacy', () => {
  it('keeps passwords, OTPs, tokens and email addresses out of the logs', async () => {
    const before = server.logs.length;
    const user = newUser();
    await server.app.inject({ method: 'POST', url: '/v1/auth/register', payload: user });
    const otp = await otpFor(user.email);
    const verified = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: { email: user.email, otp },
    });
    const tokens = json<{ tokens: { accessToken: string; refreshToken: string } }>(verified).tokens;
    await server.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { identifier: user.email, password: user.password },
    });
    await server.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { identifier: user.username, password: 'a wrong password' },
    });
    await server.app.inject({
      method: 'GET',
      url: `/v1/me?token=${tokens.refreshToken}`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    // A careless log call is scrubbed too.
    server.app.log.info(
      {
        body: {
          password: user.password,
          otp,
          nested: { refreshToken: tokens.refreshToken, apiKey: 'k' },
        },
      },
      'careless',
    );

    const output = server.logs.slice(before).join('\n');
    expect(output).toContain('careless');
    expect(output).toContain('incoming request');
    for (const secret of [
      user.password,
      otp,
      tokens.accessToken,
      tokens.refreshToken,
      user.email,
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toContain('127.0.0.1');
  });

  it('records security events with hashed IPs only', async () => {
    const { userId } = await registeredUser(server);
    const events = await server.mongo.db.collection('security_events').find({ userId }).toArray();
    expect(events.map((event) => event.type as string).sort()).toEqual(['register']);
    const event = events[0];
    expect(event?.ipHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(events)).not.toContain('127.0.0.1');
    expect(event?.expiresAt).toBeInstanceOf(Date);
  });
});

describe('@pingdost/api-client against the server', () => {
  it('registers, verifies, refreshes and logs out', async () => {
    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    let accessToken: string | undefined;
    let refreshToken = '';
    const client = createApiClient({
      baseUrl: address,
      getAccessToken: () => accessToken,
      onRefresh: async () => {
        const tokens = await auth.refresh(refreshToken);
        accessToken = tokens.accessToken;
        refreshToken = tokens.refreshToken;
        return true;
      },
    });
    const auth = authApi(client);

    await expect(client.health()).resolves.toEqual({ status: 'ok' });
    const user = newUser();
    const registered = await auth.register(user);
    expect(registered.status).toBe('pending_verification');
    const session = await auth.verifyEmail({ email: user.email, otp: await otpFor(user.email) });
    accessToken = session.tokens.accessToken;
    refreshToken = session.tokens.refreshToken;

    expect((await auth.me()).username).toBe(user.username);

    // An expired access token is refreshed transparently.
    server.clock.advance(server.config.ACCESS_TOKEN_TTL_SECONDS * 1000 + 1);
    expect((await auth.me()).userId).toBe(registered.userId);
    expect(refreshToken).not.toBe(session.tokens.refreshToken);

    await auth.logout();
    await expect(auth.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });
});
