/**
 * The recovery phrase (ADR 0022): 24 BIP39 English words for 256 random bits made on the
 * device. Only the entropy goes into the KDF, so spacing and case do not matter. BIP39's seed
 * derivation (PBKDF2) is not used.
 *
 * The phrase is never sent to the server, logged, stored, or put in analytics: callers keep it
 * in memory only while the user writes it down or types it in.
 */
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { BackupError } from './errors';

export const PHRASE_WORDS = 24;
export const PHRASE_ENTROPY_BYTES = 32;

export type RandomBytes = (length: number) => Uint8Array;

export const defaultRandomBytes: RandomBytes = (length) =>
  globalThis.crypto.getRandomValues(new Uint8Array(length));

/** A new phrase as 24 lowercase words. */
export function generatePhrase(randomBytes: RandomBytes = defaultRandomBytes): string[] {
  const entropy = randomBytes(PHRASE_ENTROPY_BYTES);
  if (entropy.length !== PHRASE_ENTROPY_BYTES) throw new Error('randomBytes: wrong length');
  return entropyToMnemonic(entropy, wordlist).split(' ');
}

/** Splits typed or pasted text into words: any whitespace, any case. */
export function normalizePhrase(input: string | readonly string[]): string[] {
  const text = typeof input === 'string' ? input : input.join(' ');
  return text.normalize('NFKD').toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether `word` is in the BIP39 English list (for live feedback while typing). */
export function isPhraseWord(word: string): boolean {
  return wordlist.includes(word.trim().toLowerCase());
}

/** Words that start with `prefix`, for suggestions (at most `limit`). */
export function suggestWords(prefix: string, limit = 4): string[] {
  const start = prefix.trim().toLowerCase();
  if (start.length < 2) return [];
  return wordlist.filter((word) => word.startsWith(start)).slice(0, limit);
}

/** The phrase's 32 bytes of entropy; `invalid_phrase` for a wrong count, word or checksum. */
export function phraseEntropy(input: string | readonly string[]): Uint8Array {
  const words = normalizePhrase(input);
  if (words.length !== PHRASE_WORDS) throw new BackupError('invalid_phrase');
  try {
    return mnemonicToEntropy(words.join(' '), wordlist);
  } catch {
    throw new BackupError('invalid_phrase');
  }
}

/**
 * Positions (0-based, ascending) to ask the user for, to check they wrote the phrase down.
 */
export function quizPositions(count = 3, randomBytes: RandomBytes = defaultRandomBytes): number[] {
  const picked = new Set<number>();
  while (picked.size < Math.min(count, PHRASE_WORDS)) {
    picked.add(randomBytes(1)[0]! % PHRASE_WORDS);
  }
  return [...picked].sort((a, b) => a - b);
}
