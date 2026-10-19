/** Login, lockout, access-token expiry, refresh rotation with reuse detection, logout. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, json, newUser, registeredUser, startTestServer, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

function login(identifier: string, password: string) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { identifier, password },
  });
}

function refresh(refreshToken: string) {
  return server.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken } });
}

function me(accessToken: string) {
  return server.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(accessToken) });
}

describe('login', () => {
  it('accepts the username or the email, in any case', async () => {
    const { user } = await registeredUser(server);
    expect((await login(user.username.toUpperCase(), user.password)).statusCode).toBe(200);
    expect((await login(` ${user.email.toUpperCase()} `, user.password)).statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const { user } = await registeredUser(server);
    const wrong = await login(user.username, 'wrong password!');
    const unknown = await login(newUser().username, 'wrong password!');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(json(wrong)).toEqual(json(unknown));
    expect(json(wrong)).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('refuses unverified accounts after checking the password', async () => {
    const user = newUser();
    await server.app.inject({ method: 'POST', url: '/v1/auth/register', payload: user });
    expect(json(await login(user.username, 'wrong password!'))).toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(json(await login(user.username, user.password))).toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
    });
  });

  it('locks an identifier after repeated failures until the window ends', async () => {
    const { user } = await registeredUser(server);
    for (let i = 0; i < 5; i++) await login(user.username, 'wrong password!');
    const locked = await login(user.username, user.password);
    expect(locked.statusCode).toBe(423);
    expect(json(locked)).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    server.clock.advance(15 * 60_000 + 1);
    expect((await login(user.username, user.password)).statusCode).toBe(200);
  });
});

describe('tokens', () => {
  it('expires access tokens with TOKEN_EXPIRED', async () => {
    const { accessToken } = await registeredUser(server);
    expect((await me(accessToken)).statusCode).toBe(200);
    server.clock.advance(server.config.ACCESS_TOKEN_TTL_SECONDS * 1000 + 1);
    expect(json(await me(accessToken))).toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
  });

  it('rejects missing, malformed and forged tokens', async () => {
    const { accessToken } = await registeredUser(server);
    expect(json(await server.app.inject({ method: 'GET', url: '/v1/me' }))).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(json(await me('not-a-jwt'))).toMatchObject({ code: 'UNAUTHENTICATED' });
    const [header, payload] = accessToken.split('.');
    expect(json(await me(`${header}.${payload}.forged-signature`))).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rotates refresh tokens', async () => {
    const session = await registeredUser(server);
    const rotated = await refresh(session.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const tokens = json<Tokens>(rotated);
    expect(tokens.refreshToken).not.toBe(session.refreshToken);
    expect((await me(tokens.accessToken)).statusCode).toBe(200);
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(200);
  });

  it('revokes the whole session when an old refresh token is reused', async () => {
    const session = await registeredUser(server);
    const current = json<Tokens>(await refresh(session.refreshToken));

    const reuse = await refresh(session.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(json(reuse)).toMatchObject({ code: 'TOKEN_REUSED' });

    // The legitimate holder is signed out too: refresh and access tokens both stop working.
    expect(json(await refresh(current.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' });
    expect(json(await me(current.accessToken))).toMatchObject({ code: 'UNAUTHENTICATED' });

    const event = await server.mongo.db
      .collection('security_events')
      .findOne({ type: 'refresh_reuse', userId: session.userId });
    expect(event).not.toBeNull();
  });

  it('rejects unknown refresh tokens', async () => {
    expect(json(await refresh('unknown-token'))).toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('logs out: the session can no longer refresh or call the API', async () => {
    const session = await registeredUser(server);
    const out = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: bearer(session.accessToken),
    });
    expect(out.statusCode).toBe(204);
    expect(json(await me(session.accessToken))).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(json(await refresh(session.refreshToken))).toMatchObject({ code: 'TOKEN_INVALID' });
  });
});
