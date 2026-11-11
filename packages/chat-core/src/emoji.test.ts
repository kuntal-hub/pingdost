import { describe, expect, it } from 'vitest';

import {
  addRecent,
  androidEmojiVersion,
  buildEmojiSet,
  deleteBefore,
  insertAt,
  loadEmojiData,
  recentEntries,
  searchEmoji,
  versionProbes,
  withTone,
  type RawEmoji,
} from './emoji';

const SAMPLE: RawEmoji[] = [
  { label: 'grinning face', emoji: '😀', group: 0, order: 1, version: 1, tags: ['face', 'grin'] },
  {
    label: 'face with tears of joy',
    emoji: '😂',
    group: 0,
    order: 2,
    version: 0.6,
    tags: ['laugh'],
  },
  {
    label: 'waving hand',
    emoji: '👋',
    group: 1,
    order: 10,
    version: 0.6,
    tags: ['hello', 'wave'],
    skins: [
      { emoji: '👋🏻', tone: 1, version: 1 },
      { emoji: '👋🏿', tone: 5, version: 1 },
    ],
  },
  {
    label: 'handshake',
    emoji: '🤝',
    group: 1,
    order: 11,
    version: 3,
    skins: [
      { emoji: '🤝🏻', tone: 1, version: 14 },
      { emoji: '🫱🏻‍🫲🏼', tone: [1, 2], version: 14 },
    ],
  },
  { label: 'light skin tone', emoji: '🏻', group: 2, order: 20, version: 1 },
  { label: 'shaking face', emoji: '🫨', group: 0, order: 3, version: 15 },
  { label: 'head shaking horizontally', emoji: '🙂‍↔️', group: 0, order: 4, version: 15.1 },
  { label: 'regional indicator A', emoji: '🇦', order: 30, version: 2 },
  { label: 'flag: India', emoji: '🇮🇳', group: 9, order: 40, version: 2, tags: ['flag'] },
];

describe('buildEmojiSet', () => {
  it('groups by category in order and drops components and loose letters', () => {
    const set = buildEmojiSet(SAMPLE, 99);
    expect(set.categories.get('smileys')?.map((e) => e.emoji)).toEqual(['😀', '😂', '🫨', '🙂‍↔️']);
    expect(set.categories.get('people')?.map((e) => e.emoji)).toEqual(['👋', '🤝']);
    expect(set.categories.get('flags')?.map((e) => e.emoji)).toEqual(['🇮🇳']);
    expect(set.byEmoji.has('🏻')).toBe(false);
    expect(set.byEmoji.has('🇦')).toBe(false);
  });

  it('hides emoji (and tones) newer than the font', () => {
    const set = buildEmojiSet(SAMPLE, 13.1);
    expect(set.categories.get('smileys')?.map((e) => e.emoji)).toEqual(['😀', '😂']);
    const handshake = set.byEmoji.get('🤝');
    expect(handshake && withTone(handshake, 1)).toBe('🤝');
  });

  it('keeps single tones only and finds an entry from a toned emoji', () => {
    const set = buildEmojiSet(SAMPLE, 99);
    const wave = set.byEmoji.get('👋🏿');
    expect(wave?.label).toBe('waving hand');
    expect(wave && withTone(wave, 5)).toBe('👋🏿');
    expect(wave && withTone(wave, 3)).toBe('👋');
    expect(wave && withTone(wave, 0)).toBe('👋');
    expect(set.byEmoji.get('🤝')?.tones).toEqual({ 1: '🤝🏻' });
  });
});

describe('searchEmoji', () => {
  const set = buildEmojiSet(SAMPLE, 99);

  it('matches name and keyword prefixes, name first', () => {
    expect(searchEmoji(set, 'fa').map((e) => e.emoji)).toEqual(['😂', '😀', '🫨']);
    expect(searchEmoji(set, 'face').map((e) => e.emoji)).toEqual(['😀', '🫨', '😂']);
    expect(searchEmoji(set, 'hello').map((e) => e.emoji)).toEqual(['👋']);
    expect(searchEmoji(set, 'tears joy').map((e) => e.emoji)).toEqual(['😂']);
    expect(searchEmoji(set, 'Face Shak').map((e) => e.emoji)).toEqual(['🫨']);
  });

  it('puts a name that starts with the query first', () => {
    const results = searchEmoji(set, 'shaking').map((e) => e.emoji);
    expect(results).toEqual(['🫨', '🙂‍↔️']);
    expect(searchEmoji(set, 'head').map((e) => e.emoji)).toEqual(['🙂‍↔️']);
  });

  it('returns nothing for an empty query or no match', () => {
    expect(searchEmoji(set, '  ')).toEqual([]);
    expect(searchEmoji(set, 'zzz')).toEqual([]);
  });
});

describe('recents', () => {
  it('moves a used emoji to the front and caps the list', () => {
    expect(addRecent(['😀', '😂'], '😂')).toEqual(['😂', '😀']);
    expect(addRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  it('drops recents the device cannot draw', () => {
    const set = buildEmojiSet(SAMPLE, 13);
    expect(recentEntries(set, ['🫨', '👋🏻', 'x'])).toEqual(['👋🏻']);
  });
});

describe('insertAt', () => {
  it('replaces the selection and moves the caret after the emoji', () => {
    expect(insertAt('hi there', { start: 2, end: 2 }, '👋')).toEqual({
      text: 'hi👋 there',
      caret: 4,
    });
    expect(insertAt('hi there', { start: 3, end: 8 }, '😀')).toEqual({ text: 'hi 😀', caret: 5 });
    expect(insertAt('', { start: 5, end: 9 }, '😀')).toEqual({ text: '😀', caret: 2 });
  });
});

describe('deleteBefore', () => {
  const cases: [string, string][] = [
    ['hi👋', 'hi'],
    ['ok 👍🏽', 'ok '],
    ['a👨‍👩‍👧', 'a'],
    ['🇮🇳🇺🇸', '🇮🇳'],
    ['x1️⃣', 'x'],
    ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', ''],
    ['❤️‍🔥', ''],
    ['abc', 'ab'],
    ['', ''],
  ];

  for (const withSegmenter of [true, false]) {
    it(`deletes one character or emoji before the caret (${withSegmenter ? 'Intl.Segmenter' : 'Hermes fallback'})`, () => {
      const saved = Intl.Segmenter;
      if (!withSegmenter) {
        Object.defineProperty(Intl, 'Segmenter', {
          value: undefined,
          configurable: true,
          writable: true,
        });
      }
      try {
        for (const [text, expected] of cases) {
          const caret = text.length;
          expect(deleteBefore(text, { start: caret, end: caret }), text).toEqual({
            text: expected,
            caret: expected.length,
          });
        }
        expect(deleteBefore('a😀b', { start: 3, end: 3 })).toEqual({ text: 'ab', caret: 1 });
      } finally {
        Object.defineProperty(Intl, 'Segmenter', {
          value: saved,
          configurable: true,
          writable: true,
        });
      }
    });
  }

  it('deletes the selection when there is one', () => {
    expect(deleteBefore('hello', { start: 1, end: 4 })).toEqual({ text: 'ho', caret: 1 });
  });
});

describe('versions', () => {
  it('maps Android API levels to the system font’s Emoji version', () => {
    expect(androidEmojiVersion(36)).toBe(16);
    expect(androidEmojiVersion(35)).toBe(15.1);
    expect(androidEmojiVersion(34)).toBe(15);
    expect(androidEmojiVersion(31)).toBe(13.1);
    expect(androidEmojiVersion(24)).toBe(4);
  });

  it('picks one probe per version, newest first, preferring single code points', () => {
    expect(versionProbes(SAMPLE)).toEqual([
      { version: 15.1, emoji: '🙂‍↔️' },
      { version: 15, emoji: '🫨' },
      { version: 3, emoji: '🤝' },
      { version: 2, emoji: '🇮🇳' },
      { version: 1, emoji: '😀' },
      { version: 0.6, emoji: '😂' },
    ]);
  });
});

describe('the real data', () => {
  it('loads, and every category has emoji', async () => {
    const data = await loadEmojiData();
    expect(data.length).toBeGreaterThan(1_800);
    const set = buildEmojiSet(data, 15.1);
    for (const id of ['smileys', 'people', 'animals', 'food', 'travel', 'activities'] as const) {
      expect(set.categories.get(id)?.length, id).toBeGreaterThan(50);
    }
    expect(searchEmoji(set, 'thumbs up')[0]?.emoji).toBe('👍');
    expect(searchEmoji(set, 'fire')[0]?.emoji).toBe('🔥');
    expect(
      searchEmoji(set, 'heart')
        .slice(0, 8)
        .map((e) => e.emoji),
    ).toContain('❤️');
    expect(set.byEmoji.get('👍')?.tones?.[3]).toBe('👍🏽');
  });
});
