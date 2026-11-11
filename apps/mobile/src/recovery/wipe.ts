// Deletes everything PingDost keeps on this phone and signs it out (ADR 0022, 0036). Used when
// the user removes the data here or deletes the account, and when another phone takes the
// account over (this device was revoked). Afterwards the phone is like new: any account can
// set it up, and nothing of the old account pops up later (the backup reminder was still
// scheduled before; found on a vivo).
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

import { authStore } from '@/api';
import { wipeAttachmentFiles } from '@/attachments/storage';
import { clearBackupDir } from '@/backup/io';
import { resetCryptoContext } from '@/crypto/bootstrap';
import { SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { DATABASE_NAME } from '@/db/open';
import { deleteEmojiPrefs } from '@/emoji/store';

import { runWipe } from './wipe-steps';

/**
 * The encrypted database (chats, sessions and this device's own record), the files, the keys
 * in secure storage (database key, pickle key, account identity key, recovery phrase,
 * session), scheduled reminders and shown notifications. Call it with the chat engine stopped.
 */
export function wipeThisPhone(): Promise<void> {
  return runWipe({
    resetCrypto: resetCryptoContext,
    deleteDatabase: () => SQLite.deleteDatabaseAsync(DATABASE_NAME),
    deleteFiles: () => {
      wipeAttachmentFiles();
      clearBackupDir();
      deleteEmojiPrefs();
      return Promise.resolve();
    },
    deleteSecrets: async () => {
      for (const item of [
        SECRET_ITEMS.databaseKey,
        SECRET_ITEMS.pickleKey,
        SECRET_ITEMS.accountIdentityKey,
        SECRET_ITEMS.backupPhrase,
      ]) {
        await SecureStore.deleteItemAsync(item, SECURE_STORE_OPTIONS).catch(() => undefined);
      }
    },
    clearNotifications: async () => {
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Notifications.dismissAllNotificationsAsync();
    },
    // Forgets the session (`pingdost.session.v1`) too.
    logout: () => authStore.getState().logout(),
  });
}
