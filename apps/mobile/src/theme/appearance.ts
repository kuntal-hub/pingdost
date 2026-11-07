// The user's appearance settings on this phone (ADR 0035). A small plain file, read
// synchronously at startup so the first frame already has the right theme. Not sensitive, not
// synced, and kept across log out: it describes this phone, not the account.
import { File, Paths } from 'expo-file-system';
import { create } from 'zustand';

import { defaultAppearance, normalizeAppearance, type AppearancePrefs } from '@pingdost/ui-tokens';

const prefsFile = () => new File(Paths.document, 'appearance.json');

function read(): AppearancePrefs {
  try {
    const file = prefsFile();
    return file.exists ? normalizeAppearance(JSON.parse(file.textSync())) : defaultAppearance;
  } catch {
    return defaultAppearance;
  }
}

function write(prefs: AppearancePrefs): void {
  try {
    const file = prefsFile();
    if (!file.exists) file.create();
    void Promise.resolve(file.write(JSON.stringify(prefs))).catch(writeFailed);
  } catch (error) {
    writeFailed(error);
  }
}

/** Losing a color choice is not worth interrupting anyone over. */
function writeFailed(error: unknown): void {
  if (__DEV__) console.warn('could not save appearance', error);
}

interface AppearanceState {
  prefs: AppearancePrefs;
  update: (patch: Partial<AppearancePrefs>) => void;
  reset: () => void;
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  prefs: read(),
  update(patch) {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    write(prefs);
  },
  reset() {
    set({ prefs: defaultAppearance });
    write(defaultAppearance);
  },
}));
