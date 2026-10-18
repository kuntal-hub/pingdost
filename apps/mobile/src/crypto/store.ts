// The device's Olm account, persisted only as a pickle (encrypted with the pickle key from
// SecureStore) in the SQLCipher `crypto_store` table (ADR 0003 point 8).
import type { SQLiteDatabase } from 'expo-sqlite';

import { decodeUtf8, encodeUtf8 } from '@/utils/bytes';
import type { CryptoProvider, OlmAccount } from '@pingdost/crypto/core';

import { getOrCreateSecret, SECRET_ITEMS } from './secrets';

const ACCOUNT_ID = 'device-olm-account';

export class CryptoStore {
  private constructor(
    private readonly db: SQLiteDatabase,
    private readonly pickleKey: Uint8Array,
    readonly account: OlmAccount,
    /** True when this run created the account; false when it was restored from the pickle. */
    readonly accountCreated: boolean,
  ) {}

  static async open(db: SQLiteDatabase, provider: CryptoProvider): Promise<CryptoStore> {
    const pickleKey = await getOrCreateSecret(SECRET_ITEMS.pickleKey);
    const row = await db.getFirstAsync<{ pickle: Uint8Array }>(
      'SELECT pickle FROM crypto_store WHERE id = ?',
      [ACCOUNT_ID],
    );
    if (row) {
      const account = provider.restoreAccount(decodeUtf8(row.pickle), pickleKey);
      return new CryptoStore(db, pickleKey, account, false);
    }
    const store = new CryptoStore(db, pickleKey, provider.createAccount(), true);
    await store.saveAccount();
    return store;
  }

  /** Re-pickles the account; call after every change (one-time keys, inbound sessions). */
  async saveAccount(): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO crypto_store (id, kind, pickle, updated_at) VALUES (?, 'olm.account', ?, ?)
       ON CONFLICT (id) DO UPDATE SET pickle = excluded.pickle, updated_at = excluded.updated_at`,
      [ACCOUNT_ID, encodeUtf8(this.account.pickle(this.pickleKey)), Date.now()],
    );
  }
}
