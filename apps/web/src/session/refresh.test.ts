// Token refresh shared by the tabs of one browser (ADR 0019, 0020). Found in Chrome: a second
// tab still held the refresh token the first tab had just rotated; its refresh was taken as
// token theft, the server revoked the session, and the browser was unlinked.
import { describe, expect, it } from 'vitest';

import type { AuthTokens } from '@pingdost/shared-types';

import { refreshShared, type TokenStore } from './refresh';

function tokens(refreshToken: string): AuthTokens {
  return {
    accessToken: `access-${refreshToken}`,
    accessTokenExpiresAt: 1,
    refreshToken,
    refreshTokenExpiresAt: 2,
  };
}

/** Rotates on every refresh; a rotated-out token revokes the session (ADR 0007). */
function fakeServer() {
  let valid = 'r1';
  let serial = 1;
  const server = {
    calls: 0,
    revoked: false,
    refresh: async (refreshToken: string): Promise<AuthTokens> => {
      server.calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (server.revoked || refreshToken !== valid) {
        server.revoked = true;
        throw Object.assign(new Error('TOKEN_REUSED'), { status: 401 });
      }
      valid = `r${++serial}`;
      return tokens(valid);
    },
  };
  return server;
}

/** The browser's shared IndexedDB record. */
function sharedStore(initial: AuthTokens): TokenStore {
  let saved = initial;
  return {
    get: () => Promise.resolve(saved),
    put: (next) => {
      saved = next;
      return Promise.resolve();
    },
  };
}

/** Like `navigator.locks.request`: one holder at a time, in order. */
function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

describe('refreshShared', () => {
  it('takes the tokens another tab already rotated instead of reusing its own', async () => {
    const server = fakeServer();
    const store = sharedStore(tokens('r1'));
    const lock = mutex();
    const first = await refreshShared({
      current: tokens('r1'),
      store,
      refresh: server.refresh,
      lock,
    });
    expect(first).toMatchObject({ ok: true, tokens: { refreshToken: 'r2' } });
    // The second tab booted with r1 and only now needs a new access token.
    const second = await refreshShared({
      current: tokens('r1'),
      store,
      refresh: server.refresh,
      lock,
    });
    expect(second).toMatchObject({ ok: true, tokens: { refreshToken: 'r2' } });
    expect(server.calls).toBe(1);
    expect(server.revoked).toBe(false);
  });

  it('lets only one of two tabs refresh at the same moment', async () => {
    const server = fakeServer();
    const store = sharedStore(tokens('r1'));
    const lock = mutex();
    const [a, b] = await Promise.all([
      refreshShared({ current: tokens('r1'), store, refresh: server.refresh, lock }),
      refreshShared({ current: tokens('r1'), store, refresh: server.refresh, lock }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(server.calls).toBe(1);
    expect(server.revoked).toBe(false);
  });

  it('reports a refusal when nobody refreshed (the browser was unlinked)', async () => {
    const server = fakeServer();
    server.revoked = true;
    const store = sharedStore(tokens('r1'));
    const result = await refreshShared({
      current: tokens('r1'),
      store,
      refresh: server.refresh,
      lock: mutex(),
    });
    expect(result.ok).toBe(false);
  });
});
