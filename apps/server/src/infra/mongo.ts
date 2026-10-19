/**
 * MongoDB (ARCHITECTURE A2): the official driver, a small pool (Atlas M0), and an index
 * registry that every module adds to and that runs at startup.
 */
import { MongoClient, MongoServerError, type Db } from 'mongodb';

export interface Mongo {
  client: MongoClient;
  db: Db;
  /** True when the server answers a ping within `timeoutMs`. */
  ping(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface MongoOptions {
  /** Overrides the database named in the URI (tests use one database per file). */
  dbName?: string;
  serverSelectionTimeoutMS?: number;
}

/** Creates the client without connecting; the driver connects on first use. */
export function createMongo(uri: string, options: MongoOptions = {}): Mongo {
  const client = new MongoClient(uri, {
    appName: 'pingdost-server',
    maxPoolSize: 10,
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 5_000,
    connectTimeoutMS: 5_000,
  });
  const db = client.db(options.dbName);
  return {
    client,
    db,
    async ping(timeoutMs = 2_000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        return await Promise.race([
          db.command({ ping: 1 }).then(
            () => true,
            () => false,
          ),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => client.close(),
  };
}

/** Creates one module's indexes; idempotent. */
export type IndexSetup = (db: Db) => Promise<void>;

export async function ensureIndexes(db: Db, setups: readonly IndexSetup[]): Promise<void> {
  for (const setup of setups) await setup(db);
}

/** The duplicate-key error's index key, e.g. `"username"`, or undefined for other errors. */
export function duplicateKeyField(error: unknown): string | undefined {
  if (!(error instanceof MongoServerError) || error.code !== 11000) return undefined;
  const keyPattern = (error as MongoServerError & { keyPattern?: Record<string, unknown> })
    .keyPattern;
  return keyPattern ? Object.keys(keyPattern)[0] : '';
}
