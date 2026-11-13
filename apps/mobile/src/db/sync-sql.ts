// The engine's hot path on expo-sqlite's synchronous calls. Every async call (`runAsync`,
// `getAllAsync`, …) is three or four round trips between the JS thread and a native worker
// (prepare, execute, read, finalize), and each one waits for the JS thread to be free again;
// a message send or receive runs dozens of statements, so they add up to seconds on a busy
// phone. The sync calls run the same statements on the JS thread through JSI, in microseconds
// for the small indexed queries the engine makes. SQLite is built thread-safe (serialized), so
// these calls and the async ones other modules still make share the connection safely.
//
// The interface stays promise-based: callers keep their `await`s (and so the same ordering),
// and a failed statement becomes a rejected promise as before.
import type { SqlDatabase, SqlValue } from '@/engine/sqlite-store';

import type { MigratableDatabase } from './migrate';

/** The part of expo-sqlite's `SQLiteDatabase` used here. */
export interface SyncSqlSource {
  execSync(source: string): void;
  runSync(source: string, params: SqlValue[]): unknown;
  getFirstSync<T>(source: string, params: SqlValue[]): T | null;
  getAllSync<T>(source: string, params: SqlValue[]): T[];
}

function settle<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export function syncSql(db: SyncSqlSource): SqlDatabase & MigratableDatabase {
  return {
    execAsync: (source) => settle(() => db.execSync(source)),
    runAsync: (source, params: SqlValue[] = []) => settle(() => db.runSync(source, params)),
    getFirstAsync: <T>(source: string, params: SqlValue[] = []) =>
      settle(() => db.getFirstSync<T>(source, params)),
    getAllAsync: <T>(source: string, params: SqlValue[] = []) =>
      settle(() => db.getAllSync<T>(source, params)),
  };
}
