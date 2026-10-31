// Settings → Log out → "Remove data from this phone" (Phase 7 handoff, ADR 0022): signs this
// device out of the account for good, then deletes everything PingDost keeps here, so the
// phone can be given away or used with another account.
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

import { api, authStore } from '@/api';
import { wipeAttachmentFiles } from '@/attachments/storage';
import { clearBackupDir } from '@/backup/io';
import { resetCryptoContext } from '@/crypto/bootstrap';
import { SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { DATABASE_NAME } from '@/db/open';
import { startChat, stopChat } from '@/engine/runtime';

/**
 * 1. revokes this device on the server (needs a connection: otherwise the account would
 *    still list this phone);
 * 2. deletes the encrypted database, the files, and the keys in secure storage (database key,
 *    pickle key, account identity key, recovery phrase, session).
 * Throws (and leaves everything in place) if the server cannot be reached.
 */
export async function removeDataFromThisPhone(): Promise<void> {
  const session = authStore.getState().session;
  if (!session) return;
  await stopChat();
  try {
    await api.push.unregisterToken().catch(() => undefined);
    if (session.deviceId) await api.devices.revoke(session.deviceId);
  } catch (error) {
    // Still this account's phone: carry on as before.
    void startChat().catch(() => undefined);
    throw error;
  }
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
