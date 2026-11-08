// One token refresh at a time across this browser's tabs (ADR 0019, 0020). The tokens live in
// the shared IndexedDB vault, and each tab also keeps a copy in memory. The server rotates the
// refresh token on every refresh and revokes the whole session when a rotated-out one comes
// back (ADR 0007), so a tab must never refresh with a copy another tab has already used.
import type { AuthTokens } from '@pingdost/shared-types';

export interface TokenStore {
  get(): Promise<AuthTokens | undefined>;
  put(tokens: AuthTokens): Promise<void>;
}

export interface RefreshDeps {
  /** This tab's copy. */
  current: AuthTokens;
  store: TokenStore;
  refresh(refreshToken: string): Promise<AuthTokens>;
  /** Runs `task` while holding a lock all tabs share (`navigator.locks` in browsers). */
  lock<T>(task: () => Promise<T>): Promise<T>;
}

export type RefreshResult = { ok: true; tokens: AuthTokens } | { ok: false; error: unknown };

export function refreshShared(deps: RefreshDeps): Promise<RefreshResult> {
  return deps.lock(async () => {
    // Another tab refreshed since this one read the tokens: use its result.
    const stored = await deps.store.get();
    if (stored && stored.refreshToken !== deps.current.refreshToken) {
      return { ok: true, tokens: stored };
    }
    try {
      const next = await deps.refresh(deps.current.refreshToken);
      await deps.store.put(next);
      return { ok: true, tokens: next };
    } catch (error) {
      return { ok: false, error };
    }
  });
}

/** The browser's cross-tab lock, or none where Web Locks are missing (then one tab only). */
export function tabLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? locks.request('pingdost-token-refresh', task) : task();
}
