/** Profiles: PATCH /v1/me, exact username lookup (rate-limited) and avatar upload signing. */
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AvatarUploadSignature, MeResponse } from '@pingdost/shared-types';

import { bearer, json, newUser, registeredUser, startTestServer, type TestServer } from './helpers';

const CLOUDINARY = {
  CLOUDINARY_CLOUD_NAME: 'pingdost-test',
  CLOUDINARY_API_KEY: '123456789012345',
  CLOUDINARY_API_SECRET: 'cloudinary-test-secret',
};

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({ env: CLOUDINARY });
});

afterAll(async () => {
  await server.close();
});

function patchMe(accessToken: string, payload: object, target = server) {
  return target.app.inject({
    method: 'PATCH',
    url: '/v1/me',
    headers: bearer(accessToken),
    payload,
  });
}

function lookup(accessToken: string, username: string, target = server) {
  return target.app.inject({
    method: 'GET',
    url: `/v1/users/by-username/${encodeURIComponent(username)}`,
    headers: bearer(accessToken),
  });
}

describe('PATCH /v1/me', () => {
  it('updates the display name and privacy preferences', async () => {
    const { accessToken } = await registeredUser(server);
    const updated = json<MeResponse>(
      await patchMe(accessToken, { displayName: '  Asha  ', privacy: { readReceipts: false } }),
    );
    expect(updated.displayName).toBe('Asha');
    expect(updated.privacy).toEqual({
      readReceipts: false,
      typingIndicators: true,
      lastSeen: true,
    });
    expect(
      json<MeResponse>(await patchMe(accessToken, { displayName: null })).displayName,
    ).toBeNull();
  });

  it('accepts only the user’s own Cloudinary avatar URL', async () => {
    const { accessToken, userId } = await registeredUser(server);
    const own = `https://res.cloudinary.com/pingdost-test/image/upload/v1760000000/avatars/${userId}.jpg`;
    expect(json<MeResponse>(await patchMe(accessToken, { avatarUrl: own })).avatarUrl).toBe(own);

    for (const avatarUrl of [
      `https://res.cloudinary.com/other-cloud/image/upload/avatars/${userId}.jpg`,
      `https://res.cloudinary.com/pingdost-test/image/upload/avatars/someone-else.jpg`,
      'https://evil.example.com/me.jpg',
    ]) {
      expect(json(await patchMe(accessToken, { avatarUrl }))).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect(json<MeResponse>(await patchMe(accessToken, { avatarUrl: null })).avatarUrl).toBeNull();
  });
});

describe('avatar upload signing', () => {
  it('signs the documented parameters with the API secret (SHA-256)', async () => {
    const { accessToken, userId } = await registeredUser(server);
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/me/avatar/sign',
      headers: bearer(accessToken),
    });
    const signed = json<AvatarUploadSignature>(response);
    expect(signed.uploadUrl).toBe('https://api.cloudinary.com/v1_1/pingdost-test/image/upload');
    const { api_key: apiKey, signature, ...params } = signed.fields;
    expect(apiKey).toBe(CLOUDINARY.CLOUDINARY_API_KEY);
    expect(params.public_id).toBe(`avatars/${userId}`);
    const toSign = Object.keys(params)
      .sort()
      .map((name) => `${name}=${params[name]}`)
      .join('&');
    expect(signature).toBe(
      createHash('sha256')
        .update(toSign + CLOUDINARY.CLOUDINARY_API_SECRET)
        .digest('hex'),
    );
    expect(response.body).not.toContain(CLOUDINARY.CLOUDINARY_API_SECRET);
  });

  it('is unavailable without Cloudinary configuration', async () => {
    const plain = await startTestServer();
    try {
      const { accessToken, userId } = await registeredUser(plain);
      const response = await plain.app.inject({
        method: 'POST',
        url: '/v1/me/avatar/sign',
        headers: bearer(accessToken),
      });
      expect(response.statusCode).toBe(503);
      const avatarUrl = `https://res.cloudinary.com/pingdost-test/image/upload/avatars/${userId}.jpg`;
      expect(json(await patchMe(accessToken, { avatarUrl }, plain))).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    } finally {
      await plain.close();
    }
  });
});

describe('profile by user ID', () => {
  it('returns the public profile of an active user, NOT_FOUND otherwise', async () => {
    const owner = await registeredUser(server);
    await patchMe(owner.accessToken, { displayName: 'Mira' });
    const reader = await registeredUser(server);
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/users/${owner.userId}`,
      headers: bearer(reader.accessToken),
    });
    expect(json(response)).toEqual({
      userId: owner.userId,
      username: owner.user.username,
      displayName: 'Mira',
      avatarUrl: null,
    });
    const missing = await server.app.inject({
      method: 'GET',
      url: '/v1/users/0192f1a0-0000-7000-8000-000000000001',
      headers: bearer(reader.accessToken),
    });
    expect(json(missing)).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('username lookup', () => {
  it('finds active users by exact username only', async () => {
    const reader = await registeredUser(server);
    const target = await registeredUser(server);
    await patchMe(target.accessToken, { displayName: 'Target' });

    const found = await lookup(reader.accessToken, target.user.username.toUpperCase());
    expect(json(found)).toEqual({
      userId: target.userId,
      username: target.user.username,
      displayName: 'Target',
      avatarUrl: null,
    });
    expect(found.body).not.toContain(target.user.email);
    expect(json(await lookup(reader.accessToken, target.user.username.slice(0, -1)))).toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );

    const pending = newUser();
    await server.app.inject({ method: 'POST', url: '/v1/auth/register', payload: pending });
    expect(json(await lookup(reader.accessToken, pending.username))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('is rate-limited per account and per IP', async () => {
    const perAccount = await startTestServer({
      throttles: { usernameLookups: { limit: 2, windowMs: 60_000 } },
    });
    const perIp = await startTestServer({
      routeLimits: { userLookup: { max: 2, timeWindow: 60_000 } },
    });
    try {
      const reader = await registeredUser(perAccount);
      await lookup(reader.accessToken, 'someone', perAccount);
      await lookup(reader.accessToken, 'someone', perAccount);
      expect(json(await lookup(reader.accessToken, 'someone', perAccount))).toMatchObject({
        code: 'RATE_LIMITED',
      });
      // Another account from the same IP still has its own budget.
      const other = await registeredUser(perAccount);
      expect((await lookup(other.accessToken, 'someone', perAccount)).statusCode).toBe(404);

      const ipReader = await registeredUser(perIp);
      await lookup(ipReader.accessToken, 'someone', perIp);
      await lookup(ipReader.accessToken, 'someone', perIp);
      const third = await lookup(ipReader.accessToken, 'someone', perIp);
      expect(third.statusCode).toBe(429);
    } finally {
      await perAccount.close();
      await perIp.close();
    }
  });
});
