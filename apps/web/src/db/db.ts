// The browser's local database (REQ §14.2, ARCHITECTURE A5/A7; ADR 0019): IndexedDB through
// Dexie, never localStorage. `keys` holds the non-extractable vault key itself (IndexedDB can
// store a CryptoKey without exposing its bytes); `records` holds values sealed with it. Chat
// tables arrive in Phase 17. The browser can evict all of it: the phone keeps the history.
import Dexie, { type EntityTable } from 'dexie';

export const DATABASE_NAME = 'pingdost';

export interface KeyRow {
  id: string;
  key: CryptoKey;
}

/** An AES-GCM sealed value (`vault.ts`). */
export interface SealedRow {
  id: string;
  iv: Uint8Array;
  data: Uint8Array;
}

export class PingdostDb extends Dexie {
  keys!: EntityTable<KeyRow, 'id'>;
  records!: EntityTable<SealedRow, 'id'>;

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(1).stores({ keys: 'id', records: 'id' });
  }
}

let current: PingdostDb | undefined;

export function database(): PingdostDb {
  current ??= new PingdostDb();
  return current;
}

/** Deletes everything this browser stored (unlinking, revocation). */
export async function wipeDatabase(): Promise<void> {
  const db = database();
  current = undefined;
  db.close();
  await Dexie.delete(db.name);
}
