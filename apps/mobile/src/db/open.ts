// Opens the SQLCipher-encrypted local database (REQ §7.5, §14.1). The raw 32-byte key lives
// in SecureStore; `x'…'` passes it to SQLCipher directly, skipping passphrase derivation.
import * as SQLite from 'expo-sqlite';

import { getOrCreateSecret, SECRET_ITEMS } from '@/crypto/secrets';
import { toHex } from '@/utils/bytes';

import { migrate } from './migrate';

export const DATABASE_NAME = 'pingdost.db';

export interface OpenedDatabase {
  db: SQLite.SQLiteDatabase;
  cipherVersion: string;
  schemaVersion: number;
}

/** Runs one open step, naming it in any error (step names and SQLite messages only). */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`database ${name} failed: ${message}`, { cause: error });
  }
}

export async function openDatabase(): Promise<OpenedDatabase> {
  const key = await getOrCreateSecret(SECRET_ITEMS.databaseKey);
  const db = await step('open', () => SQLite.openDatabaseAsync(DATABASE_NAME));
  try {
    // Must be the first statement on the connection.
    await step('key', () => db.execAsync(`PRAGMA key = "x'${toHex(key)}'"`));

    // Plain SQLite ignores PRAGMA key silently, so prove SQLCipher is linked…
    const cipher = await step('cipher check', () =>
      db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version'),
    );
    if (!cipher?.cipher_version) throw new Error('SQLCipher is not available in this build');
    // …and that the key opens the file (a wrong key fails here with SQLITE_NOTADB).
    await step('key check', () => db.getFirstAsync('SELECT count(*) AS tables FROM sqlite_master'));

    await step('setup', () => db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;'));
    const schemaVersion = await step('migration', () => migrate(db));
    return { db, cipherVersion: cipher.cipher_version, schemaVersion };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
