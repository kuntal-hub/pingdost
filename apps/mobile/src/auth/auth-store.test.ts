import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from '@pingdost/api-client';
import type { AuthSession, AuthTokens } from '@pingdost/shared-types';

import { createAuthStore, stageOf, type AuthStoreDeps } from './auth-store';
import type { SessionStorage, StoredSession } from './session';

const USER_ID = '01920000-0000-7000-8000-000000000001';
const DEVICE_ID = '01920000-0000-7000-8000-000000000002';

function tokens(n: number): AuthTokens {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: 1_000 + n,
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: 2_000 + n,
  };
}

const session: AuthSession = {
  user: { userId: USER_ID, username: 'alice', status: 'active' },
  tokens: tokens(1),
};

function memoryStorage(initial: StoredSession | null = null) {
  let saved = initial;
  const storage: SessionStorage & { saved(): StoredSession | null } = {
    load: vi.fn(() => Promise.resolve(saved)),
    save: vi.fn((next: StoredSession) => {
      saved = next;
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      saved = null;
      return Promise.resolve();
    }),
    saved: () => saved,
  };
  return storage;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function store(overrides: Partial<AuthStoreDeps> = {}, initial: StoredSession | null = null) {
  const storage = memoryStorage(initial);
  const deps: AuthStoreDeps = {
    storage,
    refresh: vi.fn(() => Promise.resolve(tokens(2))),
    logout: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return { auth: createAuthStore(deps), storage, deps };
}

const httpError = (status: number, code: 'TOKEN_REUSED' | 'RATE_LIMITED') =>
  new ApiError('http', `POST /v1/auth/refresh failed: ${status} ${code}`, { status, code });

describe('auth store', () => {
  it('hydrates from storage', async () => {
    const signedIn = store({}, { ...session, deviceId: DEVICE_ID });
    await signedIn.auth.getState().hydrate();
    expect(signedIn.auth.getState()).toMatchObject({
      status: 'signedIn',
      session: { deviceId: DEVICE_ID, tokens: tokens(1) },
    });

    const empty = store();
    expect(empty.auth.getState().status).toBe('loading');
    await empty.auth.getState().hydrate();
    expect(empty.auth.getState()).toMatchObject({ status: 'signedOut', session: null });
  });

  it('persists sign-in, the user and the device binding before exposing them', async () => {
    const { auth, storage } = store();
    await auth.getState().hydrate();
    expect(stageOf(auth.getState())).toBe('signedOut');

    await auth.getState().signIn({
      ...session,
      user: { userId: USER_ID, username: null, status: 'pending_username' },
    });
    expect(stageOf(auth.getState())).toBe('needsUsername');
    await auth.getState().signIn(session);
    expect(storage.saved()).toEqual({ ...session, deviceId: null });
    expect(auth.getState().accessToken()).toBe('access-1');
    expect(stageOf(auth.getState())).toBe('deviceSetup');

    await auth.getState().setUser({ userId: USER_ID, username: 'alice2', status: 'active' });
    await auth.getState().bindDevice(DEVICE_ID, tokens(3));
    expect(stageOf(auth.getState())).toBe('ready');
    expect(storage.saved()).toMatchObject({
      user: { username: 'alice2' },
      deviceId: DEVICE_ID,
      tokens: tokens(3),
    });
    expect(auth.getState().accessToken()).toBe('access-3');
  });

  it('shares one refresh between concurrent callers and stores the rotated pair', async () => {
    const pending = deferred<AuthTokens>();
    const refresh = vi.fn(() => pending.promise);
    const { auth, storage } = store({ refresh });
    await auth.getState().signIn(session);

    const first = auth.getState().refresh();
    const second = auth.getState().refresh();
    pending.resolve(tokens(2));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('refresh-1');
    expect(storage.saved()?.tokens).toEqual(tokens(2));

    // A later refresh is a new request with the new token.
    await auth.getState().refresh();
    expect(refresh).toHaveBeenLastCalledWith('refresh-2');
  });

  it('signs out when the refresh token is rejected, but not when offline', async () => {
    const offline = store({
      refresh: () =>
        Promise.reject(new ApiError('network', 'no response', { code: 'UNAVAILABLE' })),
    });
    await offline.auth.getState().signIn(session);
    expect(await offline.auth.getState().refresh()).toBe(false);
    expect(offline.auth.getState().status).toBe('signedIn');

    const limited = store({ refresh: () => Promise.reject(httpError(429, 'RATE_LIMITED')) });
    await limited.auth.getState().signIn(session);
    expect(await limited.auth.getState().refresh()).toBe(false);
    expect(limited.auth.getState().status).toBe('signedIn');

    const reused = store({ refresh: () => Promise.reject(httpError(401, 'TOKEN_REUSED')) });
    await reused.auth.getState().signIn(session);
    expect(await reused.auth.getState().refresh()).toBe(false);
    expect(reused.auth.getState()).toMatchObject({ status: 'signedOut', session: null });
    expect(reused.storage.saved()).toBeNull();
  });

  it('does not bring a session back when logout wins over an in-flight refresh', async () => {
    const pending = deferred<AuthTokens>();
    const { auth, storage } = store({ refresh: () => pending.promise });
    await auth.getState().signIn(session);
    const refreshing = auth.getState().refresh();
    await auth.getState().logout();
    pending.resolve(tokens(2));
    expect(await refreshing).toBe(false);
    expect(auth.getState().status).toBe('signedOut');
    expect(storage.saved()).toBeNull();
  });

  it('logs out on the server, but forgets the tokens even when it hangs', async () => {
    vi.useFakeTimers();
    try {
      const afterLogout = vi.fn(() => Promise.resolve());
      const { auth, storage, deps } = store({
        logout: () => new Promise(() => undefined),
        afterLogout,
        logoutTimeoutMs: 3_000,
      });
      await auth.getState().signIn(session);
      const done = auth.getState().logout();
      await vi.advanceTimersByTimeAsync(3_000);
      await done;
      expect(auth.getState().status).toBe('signedOut');
      expect(storage.saved()).toBeNull();
      expect(afterLogout).toHaveBeenCalledOnce();
      expect(deps.refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('api client wiring', () => {
  it('refreshes once on 401 TOKEN_EXPIRED and retries every waiting request', async () => {
    const auth = createAuthStore({
      storage: memoryStorage(),
      refresh: vi.fn(() => Promise.resolve(tokens(2))),
      logout: () => Promise.resolve(),
    });
    await auth.getState().signIn(session);

    const seen: (string | null)[] = [];
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const header = new Headers(init?.headers).get('authorization');
      seen.push(header);
      if (header === 'Bearer access-1') {
        const problem = { type: 'x', title: 'expired', status: 401, code: 'TOKEN_EXPIRED' };
        return Promise.resolve(
          new Response(JSON.stringify(problem), {
            status: 401,
            headers: { 'content-type': 'application/problem+json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      fetch,
      getAccessToken: () => auth.getState().accessToken(),
      onRefresh: () => auth.getState().refresh(),
    });

    await Promise.all([
      client.request({ method: 'GET', path: '/v1/a' }),
      client.request({ method: 'POST', path: '/v1/b' }),
    ]);
    expect(seen.filter((header) => header === 'Bearer access-1')).toHaveLength(2);
    expect(seen.filter((header) => header === 'Bearer access-2')).toHaveLength(2);
    expect(auth.getState().session?.tokens).toEqual(tokens(2));
  });
});
