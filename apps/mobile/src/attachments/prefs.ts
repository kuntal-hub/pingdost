// Storage settings (Settings → Storage), kept in the encrypted local DB and local to this phone:
// when full files download on their own. Previews always do.
import * as Network from 'expo-network';
import { z } from 'zod';
import { create } from 'zustand';

import { getCryptoContext } from '@/crypto/bootstrap';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';

import { DEFAULT_AUTO_DOWNLOAD, type AutoDownload, type NetworkKind } from './rules';

const AttachmentPrefsSchema = z.object({ autoDownload: z.enum(['wifi', 'always', 'never']) });
export type AttachmentPrefs = z.infer<typeof AttachmentPrefsSchema>;

interface PrefsState {
  prefs: AttachmentPrefs;
  loaded: boolean;
  load(): Promise<AttachmentPrefs>;
  setAutoDownload(autoDownload: AutoDownload): Promise<void>;
}

export const useAttachmentPrefs = create<PrefsState>()((set, get) => ({
  prefs: { autoDownload: DEFAULT_AUTO_DOWNLOAD },
  loaded: false,
  async load() {
    if (get().loaded) return get().prefs;
    const { db } = (await getCryptoContext()).database;
    const stored = await readSetting(db, SETTING_KEYS.attachments, AttachmentPrefsSchema);
    const prefs = stored ?? get().prefs;
    set({ prefs, loaded: true });
    return prefs;
  },
  async setAutoDownload(autoDownload) {
    const prefs = { ...(await get().load()), autoDownload };
    set({ prefs });
    const { db } = (await getCryptoContext()).database;
    await writeSetting(db, SETTING_KEYS.attachments, prefs);
  },
}));

export function networkKindOf(state: Network.NetworkState): NetworkKind {
  if (!state.isConnected || state.isInternetReachable === false) return 'offline';
  if (
    state.type === Network.NetworkStateType.WIFI ||
    state.type === Network.NetworkStateType.ETHERNET
  ) {
    return 'wifi';
  }
  return state.type === Network.NetworkStateType.CELLULAR ? 'cellular' : 'other';
}

export async function currentNetwork(): Promise<NetworkKind> {
  try {
    return networkKindOf(await Network.getNetworkStateAsync());
  } catch {
    return 'other';
  }
}
