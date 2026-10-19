// The users this account blocked (ADR 0014). The server holds the list and drops what they
// send; it is cached in the encrypted DB so the engine also drops anything they sent before
// the block, offline too. Blocked users are not told.
import { z } from 'zod';
import { create } from 'zustand';

import { api, authStore } from '@/api';
import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';

const CachedBlocksSchema = z.object({ userId: z.string(), ids: z.array(z.string()) });

interface BlockState {
  ids: string[];
  /** The server's list arrived (or the cache, offline). */
  loaded: boolean;
  /** The cached list (no network). */
  loadCached(): Promise<void>;
  /** The cached list, then the server's. */
  load(): Promise<void>;
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
}

async function cache(ids: string[]): Promise<void> {
  const userId = authStore.getState().session?.user.userId;
  if (!userId) return;
  const { db } = (await getCryptoContext()).database;
  await writeSetting(db, SETTING_KEYS.blocks, { userId, ids });
}

export const useBlocks = create<BlockState>()((set, get) => ({
  ids: [],
  loaded: false,
  async loadCached() {
    const userId = authStore.getState().session?.user.userId;
    if (get().loaded || !userId) return;
    const { db } = (await getCryptoContext()).database;
    const cached = await readSetting(db, SETTING_KEYS.blocks, CachedBlocksSchema).catch(() => null);
    if (cached?.userId === userId && !get().loaded) set({ ids: cached.ids, loaded: true });
  },
  async load() {
    await get().loadCached();
    const ids = await api.security.listBlocks();
    set({ ids, loaded: true });
    await cache(ids).catch(() => undefined);
  },
  async block(userId) {
    await api.security.block(userId);
    const ids = [...new Set([...get().ids, userId])];
    set({ ids });
    await cache(ids).catch(() => undefined);
  },
  async unblock(userId) {
    await api.security.unblock(userId);
    const ids = get().ids.filter((id) => id !== userId);
    set({ ids });
    await cache(ids).catch(() => undefined);
  },
}));

/** For the engine: whether this account blocked `userId`. */
export function isBlocked(userId: string): boolean {
  return useBlocks.getState().ids.includes(userId);
}

export function useIsBlocked(userId: string | undefined): boolean {
  return useBlocks((state) => (userId ? state.ids.includes(userId) : false));
}

// A different account must never inherit the previous one's list.
authStore.subscribe((state, previous) => {
  if (state.session?.user.userId !== previous.session?.user.userId) {
    useBlocks.setState({ ids: [], loaded: false });
  }
});
