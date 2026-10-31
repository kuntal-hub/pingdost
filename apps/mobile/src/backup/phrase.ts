// The recovery phrase on this phone (ADR 0022): only its 32 bytes of entropy, in SecureStore
// (Android Keystore), so later backups reuse the phrase the user wrote down once. Never sent
// to the server, logged, or shown again.
import * as SecureStore from 'expo-secure-store';

import { SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { fromHex, toHex } from '@/utils/bytes';
import { phraseEntropy } from '@pingdost/backup';

export async function savePhrase(words: readonly string[]): Promise<void> {
  const entropy = phraseEntropy(words);
  await SecureStore.setItemAsync(SECRET_ITEMS.backupPhrase, toHex(entropy), SECURE_STORE_OPTIONS);
  entropy.fill(0);
}

/** The stored phrase's entropy, or null before backups are set up. */
export async function loadPhraseEntropy(): Promise<Uint8Array | null> {
  const stored = await SecureStore.getItemAsync(SECRET_ITEMS.backupPhrase, SECURE_STORE_OPTIONS);
  if (!stored) return null;
  const entropy = fromHex(stored);
  return entropy.length === 32 ? entropy : null;
}

export async function hasPhrase(): Promise<boolean> {
  return (await loadPhraseEntropy()) !== null;
}
