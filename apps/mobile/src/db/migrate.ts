// Ordered SQL migrations keyed on `PRAGMA user_version` (ARCHITECTURE A6). Each runs in its
// own transaction together with the version bump, so a failure leaves the database at the
// previous version. Migration 002 adds the chat tables (Phase 10).
//
// The transaction is `BEGIN IMMEDIATE` on the same connection, never expo-sqlite's
// `withExclusiveTransactionAsync`: that opens a second connection which has no SQLCipher
// key, so every statement on it fails with "file is not a database" (ADR 0005).

import { CHAT_SCHEMA } from './migrations/002-chat';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: '001_local_settings_and_crypto_store',
    sql: `
      CREATE TABLE local_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE crypto_store (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        pickle BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  { version: 2, name: '002_chat', sql: CHAT_SCHEMA },
];

/** The subset of `SQLiteDatabase` the runner needs (keeps it testable without native code). */
export interface MigratableDatabase {
  getFirstAsync<T>(source: string): Promise<T | null>;
  execAsync(source: string): Promise<void>;
}

/** Applies pending migrations in order and returns the resulting schema version. */
export async function migrate(
  db: MigratableDatabase,
  all: readonly Migration[] = migrations,
): Promise<number> {
  const versions = all.map((migration) => migration.version);
  if (versions.some((version, index) => version !== index + 1)) {
    throw new Error('migration versions must be 1, 2, 3, … in order');
  }
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let current = row?.user_version ?? 0;
  if (current > all.length) {
    throw new Error(`database schema ${current} is newer than this app (${all.length})`);
  }
  for (const migration of all.slice(current)) {
    await db.execAsync('BEGIN IMMEDIATE');
    try {
      await db.execAsync(migration.sql);
      await db.execAsync(`PRAGMA user_version = ${migration.version}`);
      await db.execAsync('COMMIT');
    } catch (error) {
      await db.execAsync('ROLLBACK');
      throw error;
    }
    current = migration.version;
  }
  return current;
}
