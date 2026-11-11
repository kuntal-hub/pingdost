// The web emoji picker's data (Phase 36): the shared set from `@pingdost/chat-core/emoji`, cut
// to what this browser's emoji font draws, and the recents and skin tone, kept in this
// browser's localStorage only and deleted when it is unlinked.
import { create } from 'zustand';

import { onSignedOut } from '@/session/session';
import {
  addRecent,
  buildEmojiSet,
  loadEmojiData,
  MAX_RECENTS,
  versionProbes,
  type EmojiSet,
  type RawEmoji,
  type SkinTone,
} from '@pingdost/chat-core/emoji';

const KEY = 'pd.emoji.v1';

interface Saved {
  recents: string[];
  tone: SkinTone;
}

function read(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>;
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
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // Private windows can refuse storage; recents are only a convenience.
  }
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

onSignedOut(() => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to remove.
  }
  useEmojiPrefs.setState({ recents: [], tone: 0 });
});

/**
 * Whether this browser's font draws `emoji` as one colour glyph. A missing emoji is a
 * monochrome box (no colour), and a missing joined sequence falls apart into several glyphs
 * (wider than one).
 */
function draws(context: CanvasRenderingContext2D, emoji: string, oneWidth: number): boolean {
  context.clearRect(0, 0, 32, 32);
  context.fillText(emoji, 0, 0);
  if (context.measureText(emoji).width > oneWidth * 1.6) return false;
  const { data } = context.getImageData(0, 0, 32, 32);
  for (let index = 0; index < data.length; index += 4) {
    const [r = 0, g = 0, b = 0, a = 0] = [
      data[index],
      data[index + 1],
      data[index + 2],
      data[index + 3],
    ];
    if (a > 0 && (Math.abs(r - g) > 24 || Math.abs(g - b) > 24)) return true;
  }
  return false;
}

/** The newest Emoji version this browser draws, tested with one emoji of each version. */
export function browserEmojiVersion(data: readonly RawEmoji[]): number {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 15;
    context.font = '24px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    context.textBaseline = 'top';
    const oneWidth = context.measureText('😀').width;
    for (const { version, emoji } of versionProbes(data)) {
      if (draws(context, emoji, oneWidth)) return version;
    }
  } catch {
    // No canvas: assume a recent system.
  }
  return 15;
}

let loading: Promise<EmojiSet> | undefined;

export function loadEmojiSet(): Promise<EmojiSet> {
  loading ??= loadEmojiData().then((data) => buildEmojiSet(data, browserEmojiVersion(data)));
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
