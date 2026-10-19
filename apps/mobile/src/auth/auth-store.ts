// The auth state (Zustand, framework-free so it is unit-tested in Node). It owns the token
// pair: every change is persisted before it is used, refreshes are single-flight (a second
// concurrent refresh would present a rotated-out token and revoke the whole session family),
// and logout clears the tokens while local data stays on the phone.
import { createStore, type StoreApi } from 'zustand/vanilla';

import { ApiError } from '@pingdost/api-client';
import type { AuthSession, AuthTokens, AuthUser } from '@pingdost/shared-types';

import type { SessionStorage, StoredSession } from './session';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

export interface AuthState {
  status: AuthStatus;
  session: StoredSession | null;
}

export interface AuthActions {
  /** Loads the persisted session once at app start. */
  hydrate(): Promise<void>;
  /** After login, email verification or Google sign-in. */
  signIn(session: AuthSession): Promise<void>;
  /** After the Google username step changed the account summary. */
  setUser(user: AuthUser): Promise<void>;
  /** After device registration: the new pair is bound to `deviceId`. */
  bindDevice(deviceId: string, tokens: AuthTokens): Promise<void>;
  accessToken(): string | undefined;
  /** True once new tokens are stored. Concurrent calls share one request. */
  refresh(): Promise<boolean>;
  /** Revokes the server session (best effort, bounded) and forgets the tokens. */
  logout(): Promise<void>;
}

export type AuthStore = StoreApi<AuthState & AuthActions>;

/**
 * Where the app should be: the auth screens, the Google username step, device setup (the
 * tokens are not bound to a device yet), or the app itself.
 */
export type AppStage = 'loading' | 'signedOut' | 'needsUsername' | 'deviceSetup' | 'ready';

export function stageOf(state: AuthState): AppStage {
  if (state.status === 'loading') return 'loading';
  const session = state.session;
  if (state.status === 'signedOut' || !session) return 'signedOut';
  if (session.user.status === 'pending_username') return 'needsUsername';
  return session.deviceId ? 'ready' : 'deviceSetup';
}

export interface AuthStoreDeps {
  storage: SessionStorage;
  /** `POST /v1/auth/refresh`. */
  refresh: (refreshToken: string) => Promise<AuthTokens>;
  /** `POST /v1/auth/logout` with the current access token. */
  logout: () => Promise<void>;
  /** Called after the tokens are gone, e.g. to sign out of the Google SDK. */
  afterLogout?: () => Promise<void>;
  /** How long logout waits for the server before forgetting the tokens anyway. */
  logoutTimeoutMs?: number;
}

/** Answers that mean the refresh token is dead, as opposed to "try again later". */
function sessionIsGone(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http' && [401, 403].includes(error.status);
}

/** Waits for `promise` to settle, but at most `timeoutMs`; never rejects. */
async function settle(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))),
  ]);
  clearTimeout(timer);
}

export function createAuthStore(deps: AuthStoreDeps): AuthStore {
  let refreshing: Promise<boolean> | undefined;
  let hydrating: Promise<void> | undefined;

  return createStore<AuthState & AuthActions>()((set, get) => {
    async function persist(session: StoredSession): Promise<void> {
      await deps.storage.save(session);
      set({ status: 'signedIn', session });
    }

    async function forget(): Promise<void> {
      set({ status: 'signedOut', session: null });
      await deps.storage.clear();
    }

    async function doRefresh(current: StoredSession): Promise<boolean> {
      let tokens: AuthTokens;
      try {
        tokens = await deps.refresh(current.tokens.refreshToken);
      } catch (error) {
        // Offline or a server hiccup keeps the session; a rejected token ends it.
        if (sessionIsGone(error) && get().session === current) await forget();
        return false;
      }
      // A logout or a new sign-in while the request was in flight wins.
      if (get().session !== current) return false;
      await persist({ ...current, tokens });
      return true;
    }

    return {
      status: 'loading',
      session: null,

      hydrate() {
        hydrating ??= (async () => {
          const session = await deps.storage.load().catch(() => null);
          if (get().status !== 'loading') return;
          set(session ? { status: 'signedIn', session } : { status: 'signedOut', session: null });
        })();
        return hydrating;
      },

      signIn: ({ user, tokens }) => persist({ user, tokens, deviceId: null }),

      async setUser(user) {
        const current = get().session;
        if (current) await persist({ ...current, user });
      },

      async bindDevice(deviceId, tokens) {
        const current = get().session;
        if (current) await persist({ ...current, deviceId, tokens });
      },

      accessToken: () => get().session?.tokens.accessToken,

      refresh() {
        const current = get().session;
        if (!current) return Promise.resolve(false);
        refreshing ??= doRefresh(current).finally(() => {
          refreshing = undefined;
        });
        return refreshing;
      },

      async logout() {
        if (!get().session) return;
        await settle(deps.logout(), deps.logoutTimeoutMs ?? 3_000);
        await forget();
        await deps.afterLogout?.().catch(() => undefined);
      },
    };
  });
}
