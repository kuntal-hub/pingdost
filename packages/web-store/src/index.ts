// @pingdost/web-store: the browser's encrypted local storage (ADR 0019, 0020): the Dexie database,
// the non-extractable vault key and sealed records, and the message engine's `EngineStore` on
// IndexedDB. Used by the web app, and by server tests that run a browser-like device in Node.
export { database, DATABASE_NAME, PingdostDb, wipeDatabase } from './db';
export type { EngineRow, KeyRow, SealedRow, VaultKey } from './db';
export { ACCOUNT_RECORD, DexieEngineStore } from './engine-store';
export {
  decryptBytes,
  decryptRecord,
  encryptBytes,
  encryptRecord,
  SealedRecords,
  vaultKey,
} from './vault';
export type { Sealed } from './vault';
