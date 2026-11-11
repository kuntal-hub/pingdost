// This account's circle and circle requests (Phase 37, ADR 0041). The server holds them and
// refuses one-to-one traffic outside the circle; the list is cached in the encrypted DB so the
// engine also drops content from outside it over nearby and the mesh, offline too.
import { z } from 'zod';
import { create } from 'zustand';

import { api, authStore } from '@/api';
import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';
import {
  CircleMemberSchema,
  CircleRequestSchema,
  type CircleMember,
  type CircleRequest,
} from '@pingdost/shared-types';

import { circleStateOf, type CircleState } from './circle-logic';

export { circleStateOf, type CircleState } from './circle-logic';

const CachedCircleSchema = z.object({
  userId: z.string(),
  members: z.array(CircleMemberSchema),
  incoming: z.array(CircleRequestSchema),
  outgoing: z.array(CircleRequestSchema),
});

interface CircleStoreState {
  members: CircleMember[];
  incoming: CircleRequest[];
  outgoing: CircleRequest[];
  /** The server's lists arrived (or the cache, offline). */
  loaded: boolean;
  loadCached(): Promise<void>;
  /** The cached lists, then the server's. */
  load(): Promise<void>;
  request(userId: string): Promise<'requested' | 'linked'>;
  accept(userId: string): Promise<void>;
  decline(userId: string): Promise<void>;
  withdraw(userId: string): Promise<void>;
  remove(userId: string): Promise<void>;
}

async function cache(state: Pick<CircleStoreState, 'members' | 'incoming' | 'outgoing'>) {
  const userId = authStore.getState().session?.user.userId;
  if (!userId) return;
  const { db } = (await getCryptoContext()).database;
  await writeSetting(db, SETTING_KEYS.circle, {
    userId,
    members: state.members,
    incoming: state.incoming,
    outgoing: state.outgoing,
  });
}

let loading: Promise<void> | undefined;

export const useCircle = create<CircleStoreState>()((set, get) => ({
  members: [],
  incoming: [],
  outgoing: [],
  loaded: false,
  async loadCached() {
    const userId = authStore.getState().session?.user.userId;
    if (get().loaded || !userId) return;
    const { db } = (await getCryptoContext()).database;
    const cached = await readSetting(db, SETTING_KEYS.circle, CachedCircleSchema).catch(() => null);
    if (cached?.userId === userId && !get().loaded) {
      set({
        members: cached.members,
        incoming: cached.incoming,
        outgoing: cached.outgoing,
        loaded: true,
      });
    }
  },
  load() {
    // Several CircleChanged frames in a row share one refresh.
    loading ??= (async () => {
      try {
        await get().loadCached();
        const [members, requests] = await Promise.all([api.circles.list(), api.circles.requests()]);
        const next = { members, incoming: requests.incoming, outgoing: requests.outgoing };
        set({ ...next, loaded: true });
        await cache(next).catch(() => undefined);
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  },
  async request(userId) {
    const status = await api.circles.request(userId);
    await get().load();
    return status;
  },
  async accept(userId) {
    await api.circles.accept(userId);
    await get().load();
  },
  async decline(userId) {
    await api.circles.decline(userId);
    set({ incoming: get().incoming.filter((r) => r.userId !== userId) });
    await get().load();
  },
  async withdraw(userId) {
    await api.circles.withdraw(userId);
    set({ outgoing: get().outgoing.filter((r) => r.userId !== userId) });
    await get().load();
  },
  async remove(userId) {
    await api.circles.remove(userId);
    set({ members: get().members.filter((m) => m.userId !== userId) });
    await get().load();
  },
}));

/** For the engine: whether `userId` is in the circle; `undefined` before the first load. */
export function inCircle(userId: string): boolean | undefined {
  const state = useCircle.getState();
  return state.loaded ? state.members.some((m) => m.userId === userId) : undefined;
}

export function useCircleState(userId: string | undefined): CircleState | undefined {
  return useCircle((state) => (userId ? circleStateOf(state, userId) : undefined));
}

/** Requests waiting for this user's answer (the chat list's Requests row). */
export function useIncomingCount(): number {
  return useCircle((state) => state.incoming.length);
}

// A different account must never inherit the previous one's lists.
authStore.subscribe((state, previous) => {
  if (state.session?.user.userId !== previous.session?.user.userId) {
    useCircle.setState({ members: [], incoming: [], outgoing: [], loaded: false });
  }
});
