/**
 * People search (Phase 38, ADR 0042): username prefix, display-name word prefix (case- and
 * accent-folded), whole email only, no email in any answer, blocked, unverified and deleted
 * accounts left out, the two Privacy settings, and the per-account rate limit.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { UserSearchResponse } from '@pingdost/shared-types';

import {
  bearer,
  json,
  linkUsers,
  newUser,
  otpFor,
  registeredUser,
  startTestServer,
  type TestServer,
} from './helpers';

let server: TestServer;
const tag = randomBytes(3).toString('hex');

type Session = Awaited<ReturnType<typeof registeredUser>>;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

async function person(name: string, displayName?: string, target = server): Promise<Session> {
  const base = newUser();
  const session = await registeredUser(target, { ...base, username: `${name}${tag}` });
  if (displayName) {
    const patched = await target.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(session.accessToken),
      payload: { displayName },
    });
    expect(patched.statusCode).toBe(200);
  }
  return session;
}

async function search(who: Session, q: string, target = server) {
  return target.app.inject({
    method: 'GET',
    url: `/v1/users/search?q=${encodeURIComponent(q)}`,
    headers: bearer(who.accessToken),
  });
}

async function found(who: Session, q: string): Promise<string[]> {
  const response = await search(who, q);
  expect(response.statusCode).toBe(200);
  return json<UserSearchResponse>(response).results.map((r) => r.userId);
}

describe('people search', () => {
  let me: Session;
  let asha: Session;
  let zoe: Session;
  let quiet: Session;

  beforeAll(async () => {
    me = await person('me_');
    asha = await person('asha_k', 'Asha Kapoor');
    zoe = await person('zed_', 'Zoë Ångström');
    quiet = await person('quiet_', 'Quinn Hidden');
  });

  it('finds by username prefix and by name word prefix, folded', async () => {
    expect(await found(me, `asha_k${tag}`.slice(0, 6))).toContain(asha.userId);
    expect(await found(me, `@asha`)).toContain(asha.userId);
    expect(await found(me, 'kap')).toContain(asha.userId);
    expect(await found(me, 'KAPOOR')).toContain(asha.userId);
    expect(await found(me, 'asha ka')).toContain(asha.userId);
    expect(await found(me, 'zoe')).toContain(zoe.userId);
    expect(await found(me, 'angs')).toContain(zoe.userId);
    // Not the middle of a word; never the searcher.
    expect(await found(me, 'poor')).not.toContain(asha.userId);
    expect(await found(me, 'me_')).not.toContain(me.userId);
  });

  it('needs two characters and returns at most ten, the exact username first', async () => {
    expect((await search(me, 'a')).statusCode).toBe(400);
    for (let i = 0; i < 11; i++) await person(`many${i}_`, `Many Person ${i}`);
    const many = json<UserSearchResponse>(await search(me, 'many')).results;
    expect(many).toHaveLength(10);
    const exact = json<UserSearchResponse>(await search(me, `many7_${tag}`)).results;
    expect(exact[0]?.username).toBe(`many7_${tag}`);
  });

  it('finds an email only when the whole address is typed, and never returns one', async () => {
    const response = await search(me, asha.user.email.toUpperCase());
    expect(json<UserSearchResponse>(response).results.map((r) => r.userId)).toEqual([asha.userId]);
    for (const part of [
      asha.user.email.split('@')[0]!,
      asha.user.email.slice(0, -3),
      `@${asha.user.email.split('@')[1]!}`,
    ]) {
      expect(await found(me, part), part).not.toContain(asha.userId);
    }
    const all = [response, await search(me, 'asha'), await search(me, 'zoe')];
    for (const answer of all) {
      expect(answer.body).not.toMatch(/@test\.pingdost\.localhost/);
      for (const result of json<UserSearchResponse>(answer).results) {
        expect(Object.keys(result).sort()).toEqual(
          ['avatarUrl', 'circle', 'displayName', 'userId', 'username'].sort(),
        );
      }
    }
  });

  it('shows the circle state', async () => {
    const friend = await person('friend_', 'Friendly Fern');
    const asker = await person('asker_', 'Asking Ash');
    const asked = await person('asked_', 'Asked Ava');
    await linkUsers(server, me, friend);
    for (const [from, to] of [
      [asker, me],
      [me, asked],
    ] as const) {
      await server.app.inject({
        method: 'POST',
        url: '/v1/circle/requests',
        headers: bearer(from.accessToken),
        payload: { userId: to.userId },
      });
    }
    const state = async (q: string, userId: string) =>
      json<UserSearchResponse>(await search(me, q)).results.find((r) => r.userId === userId)
        ?.circle;
    expect(await state('friendly', friend.userId)).toBe('member');
    expect(await state('asking', asker.userId)).toBe('incoming');
    expect(await state('asked', asked.userId)).toBe('requested');
    expect(await state('asha', asha.userId)).toBe('none');
  });

  it('leaves out blocked, unverified and deleted accounts', async () => {
    const blocker = await person('blocker_', 'Blocking Bea');
    const blocked = await person('blockee_', 'Blocked Bo');
    for (const [who, target] of [
      [blocker, me],
      [me, blocked],
    ] as const) {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/v1/blocks/${target.userId}`,
        headers: bearer(who.accessToken),
      });
      expect(response.statusCode).toBe(204);
    }
    expect(await found(me, 'blocking')).toEqual([]);
    expect(await found(me, `blockee_${tag}`)).toEqual([]);

    const unverified = newUser();
    await server.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { ...unverified, username: `unver_${tag}` },
    });
    expect(await found(me, `unver_${tag}`)).toEqual([]);

    const leaving = await person('leaving_', 'Leaving Lee');
    expect(await found(me, 'leaving')).toEqual([leaving.userId]);
    await server.app.inject({
      method: 'POST',
      url: '/v1/me/delete/code',
      headers: bearer(leaving.accessToken),
    });
    const deleted = await server.app.inject({
      method: 'POST',
      url: '/v1/me/delete',
      headers: bearer(leaving.accessToken),
      payload: { otp: await otpFor(leaving.user.email, 2) },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await found(me, 'leaving')).toEqual([]);
  });

  it('honours "Find me by name" and "Find me by email"; an exact username always works', async () => {
    const setPrivacy = (privacy: object) =>
      server.app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: bearer(quiet.accessToken),
        payload: { privacy },
      });
    expect(await found(me, 'quinn')).toContain(quiet.userId);
    const off = await setPrivacy({ findByName: false, findByEmail: false });
    expect(json<{ privacy: object }>(off).privacy).toMatchObject({
      findByName: false,
      findByEmail: false,
    });
    expect(await found(me, 'quinn')).toEqual([]);
    expect(await found(me, `quiet_`)).not.toContain(quiet.userId);
    expect(await found(me, quiet.user.email)).toEqual([]);
    expect(await found(me, `quiet_${tag}`)).toEqual([quiet.userId]);
    await setPrivacy({ findByName: true, findByEmail: true });
    expect(await found(me, quiet.user.email)).toEqual([quiet.userId]);
  });

  it('keeps the new settings on, by default, for older accounts', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(asha.accessToken),
    });
    expect(json<{ privacy: object }>(response).privacy).toMatchObject({
      findByName: true,
      findByEmail: true,
    });
  });

  it('back-fills the search field for accounts made before it', async () => {
    const users = server.mongo.db.collection<{ _id: string; searchWords?: string[] }>('users');
    await users.updateOne({ _id: asha.userId }, { $unset: { searchWords: '' } });
    const { userSearchIndexes } = await import('../src/modules/account/search');
    await userSearchIndexes(server.mongo.db);
    expect((await users.findOne({ _id: asha.userId }))?.searchWords).toEqual(['asha', 'kapoor']);
  });
});

describe('the rate limit', () => {
  it('limits searches per account', async () => {
    const limited = await startTestServer({
      throttles: { peopleSearches: { limit: 2, windowMs: 60_000 } },
    });
    try {
      const who = await person('limit_', undefined, limited);
      expect((await search(who, 'abc', limited)).statusCode).toBe(200);
      expect((await search(who, 'abd', limited)).statusCode).toBe(200);
      const third = await search(who, 'abe', limited);
      expect(third.statusCode).toBe(429);
      expect(json(third)).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await limited.close();
    }
  });
});
