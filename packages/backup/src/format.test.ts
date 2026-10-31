import { describe, expect, it } from 'vitest';

import { decodeHeader, encodeHeader, HEADER_LENGTH } from './format';
import {
  backupFileName,
  DEFAULT_KDF_PARAMS,
  generatePhrase,
  isPhraseWord,
  phraseEntropy,
  quizPositions,
  suggestWords,
} from './index';

describe('header', () => {
  it('round-trips and is 69 bytes', () => {
    const header = {
      version: 1,
      kdf: DEFAULT_KDF_PARAMS,
      salt: new Uint8Array(32).fill(3),
      noncePrefix: new Uint8Array(19).fill(4),
    };
    const bytes = encodeHeader(header);
    expect(bytes).toHaveLength(HEADER_LENGTH);
    expect(HEADER_LENGTH).toBe(69);
    expect(decodeHeader(bytes)).toEqual(header);
    expect(DEFAULT_KDF_PARAMS).toEqual({ memoryKib: 65_536, iterations: 3, parallelism: 1 });
  });

  it('names files by local date', () => {
    expect(backupFileName(new Date(2026, 9, 31, 23, 59))).toBe('pingdost-backup-2026-10-31.pdbk');
  });
});

describe('phrase', () => {
  it('is 24 list words for 32 random bytes', () => {
    const fixed = (n: number) => new Uint8Array(n).fill(0);
    const words = generatePhrase(fixed);
    expect(words).toHaveLength(24);
    // BIP39: 256 zero bits are "abandon" × 23 + "art".
    expect(words.join(' ')).toBe(`${'abandon '.repeat(23)}art`);
    expect(phraseEntropy(words)).toEqual(new Uint8Array(32));
    expect(generatePhrase()).not.toEqual(generatePhrase());
    expect(words.every(isPhraseWord)).toBe(true);
    expect(isPhraseWord('pingdost')).toBe(false);
    expect(suggestWords('aba')).toEqual(['abandon']);
    expect(suggestWords('a')).toEqual([]);
  });

  it('quizzes three distinct positions', () => {
    const positions = quizPositions();
    expect(new Set(positions).size).toBe(3);
    expect(positions.every((p) => p >= 0 && p < 24)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
