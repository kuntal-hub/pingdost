// The signed-in account's profile and privacy preferences (`/v1/me`). Privacy preferences
// are also cached in the encrypted local DB, so later phases can honour them offline.
import { create } from 'zustand';

import { api, authStore } from '@/api';
import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';
import {
  PrivacyPrefsSchema,
  type MeResponse,
  type PrivacyPrefs,
  type UpdateMeRequest,
} from '@pingdost/shared-types';

interface AccountState {
  me: MeResponse | null;
  /** The cached preferences, shown until `me` arrives. */
  privacy: PrivacyPrefs | null;
  load(): Promise<MeResponse>;
  update(body: UpdateMeRequest): Promise<MeResponse>;
}

async function cachePrivacy(privacy: PrivacyPrefs): Promise<void> {
  const { database } = await getCryptoContext();
  await writeSetting(database.db, SETTING_KEYS.privacy, privacy);
}

export async function cachedPrivacy(): Promise<PrivacyPrefs | null> {
  const { database } = await getCryptoContext();
  return readSetting(database.db, SETTING_KEYS.privacy, PrivacyPrefsSchema);
}

export const useAccount = create<AccountState>()((set) => ({
  me: null,
  privacy: null,
  async load() {
    if (!useAccount.getState().privacy) {
      const cached = await cachedPrivacy().catch(() => null);
      if (cached) set({ privacy: cached });
    }
    const me = await api.account.me();
    set({ me, privacy: me.privacy });
    await cachePrivacy(me.privacy).catch(() => undefined);
    return me;
  },
  async update(body) {
    const me = await api.account.updateMe(body);
    set({ me, privacy: me.privacy });
    await cachePrivacy(me.privacy).catch(() => undefined);
    return me;
  },
}));

// A different account must never see the previous one's profile.
authStore.subscribe((state, previous) => {
  if (state.session?.user.userId !== previous.session?.user.userId) {
    useAccount.setState({ me: null, privacy: null });
  }
});
