// The browser's local database (REQ §14.2, ARCHITECTURE A5/A7; ADR 0019, 0020): IndexedDB
// through Dexie, never localStorage. `keys` holds the non-extractable vault key itself
// (IndexedDB can store a CryptoKey without exposing its bytes); `records` holds values sealed
// with it. Version 2 adds the message engine's tables (`engine-store.ts`): every row is a
// sealed record plus the few plaintext fields its indexes need (IDs, times, flags), never
// text, keys or pickles. The browser can evict all of it: the phone keeps the history.
import Dexie, { type EntityTable, type Table } from 'dexie';

export const DATABASE_NAME = 'pingdost';

/** A Web Crypto key (the DOM's `CryptoKey`; written so Node programs type it too). */
export type VaultKey = Parameters<typeof crypto.subtle.encrypt>[1];

export interface KeyRow {
  id: string;
  key: VaultKey;
}

/** An AES-GCM sealed value (`vault.ts`). */
export interface SealedRow {
  id: string;
  iv: Uint8Array;
  data: Uint8Array;
}

/** One cached attachment: its ciphertext is in `fileChunks` (`file-cache.ts`). */
export interface FileRow {
  attachmentId: string;
  /** The whole ciphertext's size, from the manifest. */
  size: number;
  /** Bytes stored so far, in order. */
  stored: number;
  /** All of it is here and passed its integrity check. */
  complete: boolean;
  lastUsedAt: number;
}

export interface FileChunkRow {
  attachmentId: string;
  index: number;
  data: Uint8Array;
}

/** An engine row: plaintext index fields plus the sealed record. */
export interface EngineRow {
  iv: Uint8Array;
  data: Uint8Array;
  [index: string]: unknown;
}

export class PingdostDb extends Dexie {
  keys!: EntityTable<KeyRow, 'id'>;
  records!: EntityTable<SealedRow, 'id'>;
  conversations!: Table<EngineRow, string>;
  messages!: Table<EngineRow, string>;
  deliveries!: Table<EngineRow, [string, string]>;
  outbox!: Table<EngineRow, string>;
  sessions!: Table<EngineRow, string>;
  directory!: Table<EngineRow, string>;
  directoryDevices!: Table<{ deviceId: string; userId: string }, string>;
  seen!: Table<{ id: string; seenAt: number }, string>;
  settings!: Table<EngineRow, string>;
  ops!: Table<EngineRow, string>;
  groups!: Table<EngineRow, string>;
  groupSessionsOut!: Table<EngineRow, string>;
  groupSessionsIn!: Table<EngineRow, string>;
  held!: Table<EngineRow, string>;
  files!: EntityTable<FileRow, 'attachmentId'>;
  fileChunks!: Table<FileChunkRow, [string, number]>;

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(1).stores({ keys: 'id', records: 'id' });
    this.version(2).stores({
      conversations: 'id',
      // `unread`: 1 for an incoming message not read yet; `expiring`: the deadline of an
      // outgoing message that is not settled (absent otherwise, so it is not indexed).
      messages: 'id, [conversationId+sortAt+id], [conversationId+unread], expiring, conversationId',
      deliveries: '[messageId+deviceId], messageId, [deviceId+state]',
      outbox: 'id, createdAt',
      sessions: 'id, deviceId',
      directory: 'userId',
      directoryDevices: 'deviceId, userId',
      seen: 'id, seenAt',
      settings: 'key',
      ops: 'id, targetMessageId, conversationId, receivedAt',
      groups: 'id, createdAt',
      groupSessionsOut: 'groupId',
      groupSessionsIn: 'key, groupId',
      held: 'id, groupId, receivedAt',
    });
    // Version 3 (ADR 0021): the attachment cache (`file-cache.ts`).
    this.version(3).stores({
      files: 'attachmentId, lastUsedAt',
      fileChunks: '[attachmentId+index], attachmentId',
    });
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
