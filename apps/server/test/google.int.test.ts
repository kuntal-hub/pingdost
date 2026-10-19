/** Google sign-in against a local, mocked JWKS (no network). Linking policy: ADR 0008. */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, json, newUser, registeredUser, startTestServer, type TestServer } from './helpers';

const WEB_CLIENT = 'web-client.apps.googleusercontent.com';
const ANDROID_CLIENT = 'android-client.apps.googleusercontent.com';

let server: TestServer;
let signingKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const google = await generateKeyPair('RS256');
  const stranger = await generateKeyPair('RS256');
  signingKey = google.privateKey;
  otherKey = stranger.privateKey;
  const jwk = { ...(await exportJWK(google.publicKey)), kid: 'google-test', alg: 'RS256' };
  server = await startTestServer({
    env: { GOOGLE_CLIENT_IDS: `${WEB_CLIENT},${ANDROID_CLIENT}` },
    googleKeys: createLocalJWKSet({ keys: [jwk] }),
  });
});

afterAll(async () => {
  await server.close();
});

interface IdTokenOptions {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  audience?: string;
  issuer?: string;
  expiresInSeconds?: number;
  key?: CryptoKey;
}

function idToken(options: IdTokenOptions = {}): Promise<string> {
  const now = Math.floor(server.clock.now() / 1000);
  return new SignJWT({
    email: options.email ?? `${crypto.randomUUID().slice(0, 8)}@gmail.test`,
    email_verified: options.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'google-test' })
    .setSubject(options.sub ?? `google-${crypto.randomUUID()}`)
    .setIssuer(options.issuer ?? 'https://accounts.google.com')
    .setAudience(options.audience ?? WEB_CLIENT)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 300))
    .sign(options.key ?? signingKey);
}

async function signIn(token: string) {
  return server.app.inject({ method: 'POST', url: '/v1/auth/google', payload: { idToken: token } });
}

describe('Google sign-in', () => {
  it('creates a pending_username account, then completes it with a username', async () => {
    const sub = `google-${crypto.randomUUID()}`;
    const first = await signIn(await idToken({ sub }));
    expect(first.statusCode).toBe(200);
    const session = json<{
      user: { userId: string; status: string; username: string | null };
      tokens: { accessToken: string };
    }>(first);
    expect(session.user).toMatchObject({ status: 'pending_username', username: null });

    const { username } = newUser();
    const completed = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/google/complete',
      headers: bearer(session.tokens.accessToken),
      payload: { username },
    });
    expect(json(completed)).toEqual({ userId: session.user.userId, username, status: 'active' });

    const again = json<{ user: { userId: string; status: string } }>(
      await signIn(await idToken({ sub })),
    );
    expect(again.user).toMatchObject({ userId: session.user.userId, status: 'active' });

    const twice = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/google/complete',
      headers: bearer(session.tokens.accessToken),
      payload: { username: newUser().username },
    });
    expect(json(twice)).toMatchObject({ code: 'CONFLICT' });
  });

  it('accepts every configured audience and both issuer spellings', async () => {
    expect((await signIn(await idToken({ audience: ANDROID_CLIENT }))).statusCode).toBe(200);
    expect((await signIn(await idToken({ issuer: 'accounts.google.com' }))).statusCode).toBe(200);
  });

  it.each([
    ['a wrong audience', () => idToken({ audience: 'someone-else.apps.googleusercontent.com' })],
    ['a wrong issuer', () => idToken({ issuer: 'https://evil.example.com' })],
    ['an expired token', () => idToken({ expiresInSeconds: -60 })],
    ['a foreign signing key', () => idToken({ key: otherKey })],
  ])('rejects %s', async (_name, makeToken) => {
    const response = await signIn(await makeToken());
    expect(response.statusCode).toBe(401);
    expect(json(response)).toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it('rejects garbage', async () => {
    expect(json(await signIn('not.a.jwt'))).toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it('links a verified Google email to the existing verified account', async () => {
    const { user, userId } = await registeredUser(server);
    const sub = `google-${crypto.randomUUID()}`;
    const linked = json<{ user: { userId: string } }>(
      await signIn(await idToken({ sub, email: user.email })),
    );
    expect(linked.user.userId).toBe(userId);

    const stored = await server.mongo.db.collection('users').findOne({ _id: userId as never });
    expect(stored).toMatchObject({ googleSub: sub, authProviders: ['password', 'google'] });
    // The password still works.
    const login = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { identifier: user.username, password: user.password },
    });
    expect(login.statusCode).toBe(200);
  });

  it('does not link (or sign in) an unverified Google email', async () => {
    const { user, userId } = await registeredUser(server);
    const response = await signIn(await idToken({ email: user.email, emailVerified: false }));
    expect(response.statusCode).toBe(403);
    expect(json(response)).toMatchObject({ code: 'GOOGLE_EMAIL_UNVERIFIED' });
    const stored = await server.mongo.db.collection('users').findOne({ _id: userId as never });
    expect(stored?.googleSub).toBeNull();
    expect(stored?.authProviders).toEqual(['password']);
  });

  it('replaces an unverified password registration for the same email', async () => {
    const user = newUser();
    const registered = json<{ userId: string }>(
      await server.app.inject({ method: 'POST', url: '/v1/auth/register', payload: user }),
    );
    const session = json<{ user: { userId: string; status: string } }>(
      await signIn(await idToken({ email: user.email })),
    );
    expect(session.user.status).toBe('pending_username');
    expect(session.user.userId).not.toBe(registered.userId);
    expect(await server.mongo.db.collection('users').countDocuments({ email: user.email })).toBe(1);
  });

  it('answers 503 when Google sign-in is not configured', async () => {
    const plain = await startTestServer();
    try {
      const response = await plain.app.inject({
        method: 'POST',
        url: '/v1/auth/google',
        payload: { idToken: 'x.y.z' },
      });
      expect(response.statusCode).toBe(503);
      expect(json(response)).toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      await plain.close();
    }
  });
});
