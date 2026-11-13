import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { SqliteEngineStore, type SqlValue } from '@/engine/sqlite-store';
import { runEngineStoreContract } from '@pingdost/message-engine/testing';

import { migrate, migrations } from './migrate';
import { syncSql, type SyncSqlSource } from './sync-sql';

/** node:sqlite shaped like expo-sqlite's sync calls. */
function syncSource(): SyncSqlSource & { calls: string[] } {
  const db = new DatabaseSync(':memory:');
  const bind = (params: SqlValue[]) => params as SQLInputValue[];
  const calls: string[] = [];
  return {
    calls,
    execSync(source) {
      calls.push('exec');
      db.exec(source);
    },
    runSync(source, params) {
      calls.push('run');
      return db.prepare(source).run(...bind(params));
    },
    getFirstSync: <T>(source: string, params: SqlValue[]) => {
      calls.push('first');
      return (db.prepare(source).get(...bind(params)) ?? null) as T | null;
    },
    getAllSync: <T>(source: string, params: SqlValue[]) => {
      calls.push('all');
      return db.prepare(source).all(...bind(params)) as T[];
    },
  };
}

async function migrated() {
  const sql = syncSql(syncSource());
  if ((await migrate(sql)) !== migrations.length) throw new Error('migrations did not all run');
  return sql;
}

describe('syncSql', () => {
  it('answers through the sync calls', async () => {
    const source = syncSource();
    const sql = syncSql(source);
    await sql.execAsync('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
    await sql.runAsync('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
    expect(await sql.getFirstAsync('SELECT n FROM t WHERE id = ?', ['a'])).toEqual({ n: 1 });
    expect(await sql.getFirstAsync('SELECT n FROM t WHERE id = ?', ['b'])).toBeNull();
    expect(await sql.getAllAsync('SELECT id FROM t', [])).toEqual([{ id: 'a' }]);
    expect(source.calls).toEqual(['exec', 'run', 'first', 'first', 'all']);
  });

  it('turns a failed statement into a rejected promise', async () => {
    const sql = syncSql(syncSource());
    await expect(sql.runAsync('INSERT INTO missing VALUES (?)', [1])).rejects.toThrow(/missing/);
    await expect(sql.execAsync('NOT SQL')).rejects.toThrow();
  });

  it('rolls a failed batch back like the async connection', async () => {
    const store = new SqliteEngineStore(await migrated());
    const conversation = {
      conversationId: '01890a5d-ac96-774b-bcce-b302099a8057',
      kind: 'direct' as const,
      peerUserId: '01890a5d-ac96-774b-bcce-b302099a8058',
      createdAt: 1,
      updatedAt: 1,
      lastMessageId: null,
      unreadCount: 0,
      pinnedAt: null,
      archived: false,
      mutedUntil: null,
    };
    // The conversation is written first, then the broken message fails the batch.
    await expect(
      store.apply({ conversations: [conversation], messages: [{} as never] }),
    ).rejects.toThrow();
    expect(await store.getConversation(conversation.conversationId)).toBeUndefined();
    await store.apply({ conversations: [conversation] });
    expect(await store.getConversation(conversation.conversationId)).toEqual(conversation);
  });
});

// The engine store, unchanged, over the sync calls.
runEngineStoreContract('SqliteEngineStore over syncSql', async () => {
  return new SqliteEngineStore(await migrated());
});
