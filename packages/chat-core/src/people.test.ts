import { describe, expect, it } from 'vitest';

import { isWholeEmail, matchesPerson, mergePeople, searchable, togglePicked } from './people';

const asha = { userId: 'a', username: 'asha_k', displayName: 'Asha Kapoor' };
const zoe = { userId: 'z', username: 'zed', displayName: 'Zoë Ångström' };
const plain = { userId: 'p', username: 'plain', displayName: null };

describe('matchesPerson', () => {
  it('matches a username prefix, with or without @', () => {
    expect(matchesPerson(asha, 'ash')).toBe(true);
    expect(matchesPerson(asha, '@asha_')).toBe(true);
    expect(matchesPerson(asha, 'ASHA')).toBe(true);
    expect(matchesPerson(asha, 'sha')).toBe(false);
  });

  it('matches name word prefixes, folded, all words', () => {
    expect(matchesPerson(asha, 'kap')).toBe(true);
    expect(matchesPerson(asha, 'asha ka')).toBe(true);
    expect(matchesPerson(asha, 'asha zz')).toBe(false);
    expect(matchesPerson(zoe, 'zoe')).toBe(true);
    expect(matchesPerson(zoe, 'angs')).toBe(true);
    expect(matchesPerson(plain, 'pl')).toBe(true);
    expect(matchesPerson(plain, 'xy')).toBe(false);
  });

  it('matches everyone for an empty query', () => {
    expect(matchesPerson(asha, '  ')).toBe(true);
  });
});

describe('query kinds', () => {
  it('tells whole emails from fragments', () => {
    expect(isWholeEmail('asha@example.com')).toBe(true);
    expect(isWholeEmail(' asha@example.com ')).toBe(true);
    expect(isWholeEmail('asha@')).toBe(false);
    expect(isWholeEmail('@example.com')).toBe(false);
    expect(isWholeEmail('asha')).toBe(false);
  });

  it('asks the server from two characters', () => {
    expect(searchable('a')).toBe(false);
    expect(searchable('@a')).toBe(false);
    expect(searchable('as')).toBe(true);
  });
});

describe('lists', () => {
  it('puts local matches first and drops duplicates', () => {
    expect(
      mergePeople([{ userId: 'a' }], [{ userId: 'b' }, { userId: 'a' }]).map((p) => p.userId),
    ).toEqual(['a', 'b']);
  });

  it('toggles picks in picking order', () => {
    expect(togglePicked(['a'], 'b')).toEqual(['a', 'b']);
    expect(togglePicked(['a', 'b'], 'a')).toEqual(['b']);
  });
});
