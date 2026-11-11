// The emoji picker's data, the same on the phone and the web (Phase 36): emojibase-data 18
// (MIT) grouped into categories, searched by name and keyword, with skin tones. Recents are kept
// by each app on its own device; the helpers here only order them.

/** One entry of emojibase-data's `en/data.json` (the fields the picker reads). */
export interface RawEmoji {
  label: string;
  emoji: string;
  group?: number;
  order?: number;
  version: number;
  tags?: string[];
  skins?: { emoji: string; tone?: number | number[]; version: number }[];
}

export type EmojiCategoryId =
  | 'recent'
  | 'smileys'
  | 'people'
  | 'animals'
  | 'food'
  | 'travel'
  | 'activities'
  | 'objects'
  | 'symbols'
  | 'flags';

/** The categories in picker order. `recent` is filled from the device's own list. */
export const EMOJI_CATEGORIES: readonly { id: EmojiCategoryId; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'smileys', label: 'Smileys' },
  { id: 'people', label: 'People' },
  { id: 'animals', label: 'Animals and nature' },
  { id: 'food', label: 'Food and drink' },
  { id: 'travel', label: 'Travel and places' },
  { id: 'activities', label: 'Activities' },
  { id: 'objects', label: 'Objects' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'flags', label: 'Flags' },
];

/** emojibase's group numbers; 2 (skin tone and hair components) is not shown. */
const GROUPS: Record<number, Exclude<EmojiCategoryId, 'recent'>> = {
  0: 'smileys',
  1: 'people',
  3: 'animals',
  4: 'food',
  5: 'travel',
  6: 'activities',
  7: 'objects',
  8: 'symbols',
  9: 'flags',
};

/** 0 is the default yellow; 1–5 are light to dark. */
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;

export const SKIN_TONES: readonly { tone: SkinTone; label: string; swatch: string }[] = [
  { tone: 0, label: 'Default', swatch: '✋' },
  { tone: 1, label: 'Light', swatch: '✋🏻' },
  { tone: 2, label: 'Medium-light', swatch: '✋🏼' },
  { tone: 3, label: 'Medium', swatch: '✋🏽' },
  { tone: 4, label: 'Medium-dark', swatch: '✋🏾' },
  { tone: 5, label: 'Dark', swatch: '✋🏿' },
];

export interface EmojiEntry {
  emoji: string;
  /** Its name, for search and screen readers ("waving hand"). */
  label: string;
  category: Exclude<EmojiCategoryId, 'recent'>;
  /** Lower-case words to match: the name's words and the keywords. */
  words: string[];
  /** The same emoji in each single skin tone the device can draw, when it has them. */
  tones?: Partial<Record<Exclude<SkinTone, 0>, string>>;
}

export interface EmojiSet {
  categories: ReadonlyMap<Exclude<EmojiCategoryId, 'recent'>, readonly EmojiEntry[]>;
  /** Any form of an emoji (a toned one too) to its entry. */
  byEmoji: ReadonlyMap<string, EmojiEntry>;
  all: readonly EmojiEntry[];
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/**
 * Groups the data into categories, leaving out what the device's emoji font cannot draw
 * (`maxVersion`, an Emoji version such as 15.1), so no empty boxes appear.
 */
export function buildEmojiSet(data: readonly RawEmoji[], maxVersion: number): EmojiSet {
  const categories = new Map<Exclude<EmojiCategoryId, 'recent'>, EmojiEntry[]>();
  const byEmoji = new Map<string, EmojiEntry>();
  const all: EmojiEntry[] = [];
  const sorted = [...data].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const raw of sorted) {
    const category = raw.group === undefined ? undefined : GROUPS[raw.group];
    if (!category || raw.version > maxVersion) continue;
    const tones: Partial<Record<Exclude<SkinTone, 0>, string>> = {};
    for (const skin of raw.skins ?? []) {
      // Only one tone for the whole emoji; mixed tones (two people) are left out.
      if (typeof skin.tone !== 'number' || skin.version > maxVersion) continue;
      if (skin.tone >= 1 && skin.tone <= 5) tones[skin.tone as Exclude<SkinTone, 0>] = skin.emoji;
    }
    const entry: EmojiEntry = {
      emoji: raw.emoji,
      label: raw.label,
      category,
      words: [...new Set([...words(raw.label), ...(raw.tags ?? []).flatMap(words)])],
      ...(Object.keys(tones).length > 0 ? { tones } : {}),
    };
    all.push(entry);
    byEmoji.set(entry.emoji, entry);
    for (const toned of Object.values(tones)) byEmoji.set(toned, entry);
    const list = categories.get(category) ?? [];
    list.push(entry);
    categories.set(category, list);
  }
  return { categories, byEmoji, all };
}

/** The emoji as drawn in the chosen tone, if it has that tone. */
export function withTone(entry: EmojiEntry, tone: SkinTone): string {
  return tone === 0 ? entry.emoji : (entry.tones?.[tone] ?? entry.emoji);
}

/**
 * Emoji whose name or keywords start with every word of the query, best first: the exact
 * name, whole words of the name, the name starting with the query, words of the name
 * starting with it, then keywords. Empty for an empty query.
 */
export function searchEmoji(set: EmojiSet, query: string, limit = 120): EmojiEntry[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const scored: { entry: EmojiEntry; score: number; index: number; length: number }[] = [];
  const phrase = terms.join(' ');
  set.all.forEach((entry, index) => {
    if (!terms.every((term) => entry.words.some((word) => word.startsWith(term)))) return;
    const nameWords = words(entry.label);
    const name = nameWords.join(' ');
    const score =
      name === phrase
        ? 0
        : terms.every((term) => nameWords.includes(term))
          ? 1
          : name.startsWith(phrase)
            ? 2
            : terms.every((term) => nameWords.some((word) => word.startsWith(term)))
              ? 3
              : 4;
    scored.push({ entry, score, index, length: nameWords.length });
  });
  // Among equals, the shorter name is the closer match ("red heart" before "smiling face with heart-eyes").
  scored.sort((a, b) => a.score - b.score || a.length - b.length || a.index - b.index);
  return scored.slice(0, limit).map(({ entry }) => entry);
}

export const MAX_RECENTS = 32;

/** The device's recents after using `emoji`: it moves to the front, the list stays short. */
export function addRecent(recents: readonly string[], emoji: string, max = MAX_RECENTS): string[] {
  return [emoji, ...recents.filter((item) => item !== emoji)].slice(0, max);
}

/** Recents the device can still draw (an OS downgrade or new data can drop some). */
export function recentEntries(set: EmojiSet, recents: readonly string[]): string[] {
  return recents.filter((emoji) => set.byEmoji.has(emoji));
}

/**
 * The newest Emoji version Android's own font draws, by API level. React Native's Text uses
 * the system font (no EmojiCompat), so newer emoji would show as boxes.
 */
export function androidEmojiVersion(apiLevel: number): number {
  if (apiLevel >= 37) return 17;
  if (apiLevel >= 36) return 16;
  if (apiLevel >= 35) return 15.1;
  if (apiLevel >= 34) return 15;
  if (apiLevel >= 33) return 14;
  if (apiLevel >= 31) return 13.1;
  if (apiLevel >= 30) return 13;
  if (apiLevel >= 29) return 12;
  if (apiLevel >= 28) return 11;
  if (apiLevel >= 26) return 5;
  return 4;
}

/** One emoji of each Emoji version, for a browser to test its font with (newest first). */
export function versionProbes(data: readonly RawEmoji[]): { version: number; emoji: string }[] {
  const probes = new Map<number, string>();
  for (const raw of data) {
    if (raw.group === undefined || raw.group === 2) continue;
    const current = probes.get(raw.version);
    // A single code point tests the font best; a sequence only when the version has no other.
    const single = [...raw.emoji.replace(/\u{FE0F}/gu, '')].length === 1;
    if (current === undefined || (single && [...current.replace(/\u{FE0F}/gu, '')].length > 1)) {
      probes.set(raw.version, raw.emoji);
    }
  }
  return [...probes.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([version, emoji]) => ({ version, emoji }));
}

/** Inserts `emoji` over the selection; returns the new text and where the caret goes. */
export function insertAt(
  text: string,
  selection: { start: number; end: number },
  emoji: string,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  return { text: text.slice(0, start) + emoji + text.slice(end), caret: start + emoji.length };
}

/** Variation selectors, the keycap mark, skin tones and tag characters: part of the emoji before them. */
function isExtender(point: string | undefined): boolean {
  const code = point?.codePointAt(0) ?? 0;
  return (
    code === 0xfe0e ||
    code === 0xfe0f ||
    code === 0x20e3 ||
    (code >= 0x1f3fb && code <= 0x1f3ff) ||
    (code >= 0xe0020 && code <= 0xe007f)
  );
}

/** Half of a flag. */
function regional(point: string | undefined): boolean {
  const code = point?.codePointAt(0) ?? 0;
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

/** Where the character (an emoji with its joins, tones and flags counts as one) before `index` starts. */
export function previousCharacter(text: string, index: number): number {
  const before = text.slice(0, index);
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    let start = 0;
    for (const segment of new Segmenter(undefined, { granularity: 'grapheme' }).segment(before)) {
      start = segment.index;
    }
    return start;
  }
  // Hermes has no Intl.Segmenter: walk back over code points by the emoji rules that matter.
  const points = Array.from(before);
  let at = points.length;
  const unit = () => {
    while (at > 0 && isExtender(points[at - 1])) at -= 1;
    if (at > 0) at -= 1;
  };
  unit();
  while (at > 1 && points[at - 1] === '‍') {
    at -= 1;
    unit();
  }
  // A flag is two regional indicators; an odd run pairs from its start.
  if (regional(points[at])) {
    let run = 0;
    while (at - run > 0 && regional(points[at - run - 1])) run += 1;
    if (run % 2 === 1) at -= 1;
  }
  return points.slice(0, at).join('').length;
}

/** Backspace in the emoji panel: deletes the selection, or the character before the caret. */
export function deleteBefore(
  text: string,
  selection: { start: number; end: number },
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  if (end > start) return { text: text.slice(0, start) + text.slice(end), caret: start };
  const from = previousCharacter(text, start);
  return { text: text.slice(0, from) + text.slice(start), caret: from };
}

/** The emoji data, loaded only when a picker first opens (about 0.8 MB). */
export async function loadEmojiData(): Promise<RawEmoji[]> {
  const module = (await import('emojibase-data/en/data.json')) as unknown as {
    default: RawEmoji[];
  };
  return module.default;
}
