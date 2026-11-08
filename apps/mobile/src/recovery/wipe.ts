// Deletes everything PingDost keeps on this phone and signs it out (ADR 0022). Used when the user
// removes the data here, and when another phone takes the account over (this device was
// revoked). Afterwards the phone is like new: any account can set it up.
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

import { authStore } from '@/api';
import { wipeAttachmentFiles } from '@/attachments/storage';
import { clearBackupDir } from '@/backup/io';
import { resetCryptoContext } from '@/crypto/bootstrap';
import { SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { DATABASE_NAME } from '@/db/open';

/**
 * The encrypted database (chats, sessions and this device's own record), the files, and the
 * keys in secure storage (database key, pickle key, account identity key, recovery phrase,
 * session). Call it with the chat engine stopped.
 */
export async function wipeThisPhone(): Promise<void> {
  await resetCryptoContext();
  await SQLite.deleteDatabaseAsync(DATABASE_NAME).catch(() => undefined);
  wipeAttachmentFiles();
  clearBackupDir();
  for (const item of [
    SECRET_ITEMS.databaseKey,
    SECRET_ITEMS.pickleKey,
    SECRET_ITEMS.accountIdentityKey,
    SECRET_ITEMS.backupPhrase,
  ]) {
    await SecureStore.deleteItemAsync(item, SECURE_STORE_OPTIONS).catch(() => undefined);
  }
  // Forgets the session (`pingdost.session.v1`) too.
  await authStore.getState().logout();
}
