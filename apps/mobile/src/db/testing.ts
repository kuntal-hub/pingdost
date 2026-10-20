// Tests only: the app's SQL on Node's built-in SQLite, with the real migrations (SQLCipher
// itself is checked on the device). Never imported by app code.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { SqlDatabase, SqlValue } from '@/engine/sqlite-store';

import { migrate, migrations, type MigratableDatabase } from './migrate';

export function nodeDatabase(): SqlDatabase & MigratableDatabase {
  const db = new DatabaseSync(':memory:');
  const bind = (params: SqlValue[] = []) => params as SQLInputValue[];
  return {
    execAsync(source) {
      db.exec(source);
      return Promise.resolve();
    },
    runAsync: (source, params) => Promise.resolve(db.prepare(source).run(...bind(params))),
    getFirstAsync: <T>(source: string, params?: SqlValue[]) =>
      Promise.resolve((db.prepare(source).get(...bind(params)) ?? null) as T | null),
    getAllAsync: <T>(source: string, params?: SqlValue[]) =>
      Promise.resolve(db.prepare(source).all(...bind(params)) as T[]),
  };
}

/** A fresh in-memory database at the latest schema. */
export async function migratedDatabase(): Promise<SqlDatabase & MigratableDatabase> {
  const db = nodeDatabase();
  const version = await migrate(db);
  if (version !== migrations.length) throw new Error('migrations did not all run');
  return db;
}
