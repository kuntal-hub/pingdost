// 32-byte device secrets (the SQLCipher key and the Olm pickle key) in expo-secure-store,
// which encrypts them with an Android Keystore key (ARCHITECTURE A5). Never logged.
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { fromHex, toHex } from '@/utils/bytes';

export const SECRET_ITEMS = {
  databaseKey: 'pingdost.db-key.v1',
  pickleKey: 'pingdost.pickle-key.v1',
  /** The account identity key secret (ADR 0008); only on the primary phone. */
  accountIdentityKey: 'pingdost.account-identity-key.v1',
  /** The signed-in session (token pair, account summary, bound device ID). */
  session: 'pingdost.session.v1',
} as const;

export const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  // iOS: never synced to iCloud Keychain or restored onto another device.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Returns the stored 32-byte secret, creating it on first use. */
export async function getOrCreateSecret(item: string): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(item, SECURE_STORE_OPTIONS);
  if (stored !== null) {
    const secret = fromHex(stored);
    if (secret.length !== 32) throw new Error(`stored secret ${item} has the wrong length`);
    return secret;
  }
  const secret = await Crypto.getRandomBytesAsync(32);
  await SecureStore.setItemAsync(item, toHex(secret), SECURE_STORE_OPTIONS);
  return secret;
}
