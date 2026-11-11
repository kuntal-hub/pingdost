// The emoji picker's memory on this phone (Phase 36): recently used emoji and the chosen skin
// tone. A small plain file like the appearance settings; it never leaves the phone and is
// deleted with the rest of the data (`recovery/wipe.ts`).
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { create } from 'zustand';

import {
  addRecent,
  androidEmojiVersion,
  buildEmojiSet,
  loadEmojiData,
  MAX_RECENTS,
  type EmojiSet,
  type SkinTone,
} from '@pingdost/chat-core/emoji';

const prefsFile = () => new File(Paths.document, 'emoji.json');

interface Saved {
  recents: string[];
  tone: SkinTone;
}

function read(): Saved {
  try {
    const file = prefsFile();
    if (!file.exists) return { recents: [], tone: 0 };
    const raw = JSON.parse(file.textSync()) as Partial<Saved>;
    const recents = Array.isArray(raw.recents)
      ? raw.recents.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENTS)
      : [];
    const tone = [0, 1, 2, 3, 4, 5].includes(raw.tone as number) ? (raw.tone as SkinTone) : 0;
    return { recents, tone };
  } catch {
    return { recents: [], tone: 0 };
  }
}

function write(saved: Saved): void {
  try {
    const file = prefsFile();
    if (!file.exists) file.create();
    void Promise.resolve(file.write(JSON.stringify(saved))).catch(writeFailed);
  } catch (error) {
    writeFailed(error);
  }
}

function writeFailed(error: unknown): void {
  if (__DEV__) console.warn('could not save emoji recents', error);
}

/** Deletes the file (Remove data, account deletion). */
export function deleteEmojiPrefs(): void {
  try {
    const file = prefsFile();
    if (file.exists) file.delete();
  } catch {
    // Nothing that identifies anyone; the wipe goes on.
  }
  useEmojiPrefs.setState({ recents: [], tone: 0 });
}

interface EmojiPrefsState extends Saved {
  used: (emoji: string) => void;
  setTone: (tone: SkinTone) => void;
}

export const useEmojiPrefs = create<EmojiPrefsState>((set, get) => ({
  ...read(),
  used(emoji) {
    const recents = addRecent(get().recents, emoji);
    set({ recents });
    write({ recents, tone: get().tone });
  },
  setTone(tone) {
    set({ tone });
    write({ recents: get().recents, tone });
  },
}));

let loading: Promise<EmojiSet> | undefined;

/**
 * The emoji this phone's font can draw, loaded the first time a picker opens. React Native's
 * text uses the system font, so the Android version decides.
 */
export function loadEmojiSet(): Promise<EmojiSet> {
  loading ??= loadEmojiData().then((data) =>
    buildEmojiSet(
      data,
      Platform.OS === 'android' ? androidEmojiVersion(Number(Platform.Version)) : 15.1,
    ),
  );
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
