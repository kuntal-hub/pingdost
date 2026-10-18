// App-start crypto setup: encrypted DB → native provider → device account. Runs once per
// process; the timings feed the cold-start measurement in ADR 0005 (no secrets logged).
import { openDatabase, type OpenedDatabase } from '@/db/open';
import type { CryptoProvider } from '@pingdost/crypto/core';
import { createNativeCryptoProvider } from '@pingdost/crypto-native';

import { CryptoStore } from './store';

export interface CryptoContext {
  provider: CryptoProvider;
  database: OpenedDatabase;
  store: CryptoStore;
  timings: {
    /** SecureStore key + SQLCipher open + migrations. */
    databaseMs: number;
    /** Pickle key + account restore (or creation), including the first native library call. */
    accountMs: number;
    totalMs: number;
  };
}

let context: Promise<CryptoContext> | undefined;

async function bootstrap(): Promise<CryptoContext> {
  const start = performance.now();
  const database = await openDatabase();
  const afterDatabase = performance.now();
  const provider = createNativeCryptoProvider();
  const store = await CryptoStore.open(database.db, provider);
  const end = performance.now();

  const timings = {
    databaseMs: Math.round(afterDatabase - start),
    accountMs: Math.round(end - afterDatabase),
    totalMs: Math.round(end - start),
  };
  console.log(
    `[crypto] ready in ${timings.totalMs} ms (db ${timings.databaseMs} ms, account ${timings.accountMs} ms, ${store.accountCreated ? 'created' : 'restored'})`,
  );
  return { provider, database, store, timings };
}

/** The process-wide crypto context; the first call starts it, and a failure allows a retry. */
export function getCryptoContext(): Promise<CryptoContext> {
  context ??= bootstrap().catch((error: unknown) => {
    context = undefined;
    throw error;
  });
  return context;
}
