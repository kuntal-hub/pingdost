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
    private current: OlmAccount,
    /** True when this run created the account; false when it was restored from the pickle. */
    readonly accountCreated: boolean,
    private readonly provider: CryptoProvider,
  ) {}

  get account(): OlmAccount {
    return this.current;
  }

  static async open(db: SQLiteDatabase, provider: CryptoProvider): Promise<CryptoStore> {
    const pickleKey = await getOrCreateSecret(SECRET_ITEMS.pickleKey);
    const row = await db.getFirstAsync<{ pickle: Uint8Array }>(
      'SELECT pickle FROM crypto_store WHERE id = ?',
      [ACCOUNT_ID],
    );
    if (row) {
      const account = provider.restoreAccount(decodeUtf8(row.pickle), pickleKey);
      return new CryptoStore(db, pickleKey, account, false, provider);
    }
    const store = new CryptoStore(db, pickleKey, provider.createAccount(), true, provider);
    await store.saveAccount();
    return store;
  }

  /** Re-pickles the account; call after every change (one-time keys, inbound sessions). */
  async saveAccount(): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO crypto_store (id, kind, pickle, updated_at) VALUES (?, 'olm.account', ?, ?)
       ON CONFLICT (id) DO UPDATE SET pickle = excluded.pickle, updated_at = excluded.updated_at`,
      [ACCOUNT_ID, encodeUtf8(this.current.pickle(this.pickleKey)), Date.now()],
    );
  }

  /**
   * Replaces the account with a new one, for a device the server revoked: its identity keys
   * are burned. Sessions made with the old account stop working.
   */
  async resetAccount(): Promise<void> {
    const previous = this.current;
    this.current = this.provider.createAccount();
    await this.saveAccount();
    previous.dispose();
  }
}
