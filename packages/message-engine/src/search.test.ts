import { describe, expect, it } from 'vitest';

import { foldText, ftsQuery, highlightRanges, matchesQuery, searchTerms } from './search';

describe('search terms', () => {
  it('folds case and Latin accents, and splits on punctuation and emoji', () => {
    expect(foldText('Café ÉLAN')).toBe('cafe elan');
    expect(searchTerms('  Hello,  wörld-wide 😀 ')).toEqual([['hello'], ['world', 'wide']]);
    expect(searchTerms('नमस्ते')).toEqual([['नमस्ते']]);
    expect(searchTerms('?! …')).toEqual([]);
  });

  it('builds an FTS5 query from quoted prefix phrases only', () => {
    expect(ftsQuery('hello wörld-wide')).toBe('"hello"* "world wide"*');
    expect(ftsQuery('OR NEAR(a) "x" AND')).toBe('"or"* "near a"* "x"* "and"*');
    expect(ftsQuery(' ;; ')).toBeUndefined();
  });

  it('matches every term as a word prefix', () => {
    expect(matchesQuery('See you at the café tomorrow', 'CAFE tom')).toBe(true);
    expect(matchesQuery('See you at the café tomorrow', 'cafe xyz')).toBe(false);
    expect(matchesQuery('well-known fact', 'well-kn')).toBe(true);
    expect(matchesQuery('known well', 'well-kn')).toBe(false);
    expect(matchesQuery('anything', '')).toBe(false);
  });

  it('marks the matching words for highlighting', () => {
    const text = 'Hello there, hello again';
    expect(highlightRanges(text, 'hel')).toEqual([
      { start: 0, end: 5 },
      { start: 13, end: 18 },
    ]);
    expect(highlightRanges('a 😀 Böse', 'bose')).toEqual([{ start: 5, end: 9 }]);
    expect(highlightRanges(text, 'zzz')).toEqual([]);
  });
});
