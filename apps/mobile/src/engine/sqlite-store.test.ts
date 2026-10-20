// The SQLite store against the shared EngineStore contract, on Node's built-in SQLite with
// the app's real migrations (SQLCipher itself is checked on the device).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { migrate, migrations, type MigratableDatabase } from '@/db/migrate';
import { createWasmCryptoProvider } from '@pingdost/crypto';
import {
  createTestClient,
  eventually,
  FakeServer,
  messageRecord,
  runEngineStoreContract,
} from '@pingdost/message-engine/testing';

import { SqliteEngineStore, wipeChatData, type SqlDatabase, type SqlValue } from './sqlite-store';

function nodeDatabase(): SqlDatabase & MigratableDatabase {
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

async function migrated() {
  const db = nodeDatabase();
  expect(await migrate(db)).toBe(migrations.length);
  return db;
}

runEngineStoreContract(
  'SQLite (migrations 002–004)',
  async () => new SqliteEngineStore(await migrated()),
);

describe('SqliteEngineStore', () => {
  it('keeps the account pickle in the row CryptoStore uses', async () => {
    const db = await migrated();
    await new SqliteEngineStore(db).apply({ account: 'pickled' });
    const row = await db.getFirstAsync<{ kind: string; pickle: Uint8Array }>(
      "SELECT kind, pickle FROM crypto_store WHERE id = 'device-olm-account'",
      [],
    );
    expect(row?.kind).toBe('olm.account');
    expect(new TextDecoder().decode(row?.pickle)).toBe('pickled');
  });

  it('writes nothing from a batch that fails part-way', async () => {
    const db = await migrated();
    const store = new SqliteEngineStore(db);
    const message = messageRecord();
    const broken = { ...messageRecord(), body: null as unknown as string }; // NOT NULL
    await expect(store.apply({ messages: [message, broken] })).rejects.toThrow();
    expect(await store.getMessage(message.messageId)).toBeUndefined();
    // The connection is usable afterwards.
    await store.apply({ messages: [message] });
    expect(await store.getMessage(message.messageId)).toEqual(message);
  });

  it('wipes chat data and sessions but keeps the account', async () => {
    const db = await migrated();
    const store = new SqliteEngineStore(db);
    await store.apply({
      account: 'pickled',
      messages: [messageRecord()],
      seen: [{ id: 'x', seenAt: 1 }],
      settings: { 'engine.fallbackKeyRotatedAt': 5, other: true },
    });
    await wipeChatData(db);
    expect(await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM messages', [])).toEqual(
      { n: 0 },
    );
    expect(await store.hasSeen('x')).toBe(false);
    expect(await store.getSetting('engine.fallbackKeyRotatedAt')).toBeUndefined();
    expect(await store.getSetting('other')).toBe(true);
    expect(await db.getFirstAsync('SELECT 1 AS ok FROM crypto_store', [])).toEqual({ ok: 1 });
    expect(
      await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM messages_fts', []),
    ).toEqual({ n: 0 });
  });

  it('upgrades a Phase 10 database: old messages are searchable and count as read', async () => {
    const db = nodeDatabase();
    expect(await migrate(db, migrations.slice(0, 2))).toBe(2);
    await db.runAsync(
      `INSERT INTO messages (message_id, conversation_id, sender_user_id, sender_device_id,
         direction, kind, body, reply_to, sent_at, sort_at, created_at, state, expires_at)
       VALUES ('m1', 'c1', 'u1', 'd1', 'in', 'text', 'Old greetings, friend', NULL, 1, 1, 2, NULL, NULL)`,
      [],
    );
    expect(await migrate(db)).toBe(migrations.length);
    const store = new SqliteEngineStore(db);
    const [found] = await store.searchMessages('greet', { limit: 5 });
    expect(found).toMatchObject({ messageId: 'm1', readAt: 2, reactions: [], editedAt: null });
    expect(await store.listUnread('c1')).toEqual([]);
  });
});

describe('the engine on SQLite', () => {
  it('delivers both ways and keeps its outbox and sessions across a restart', async () => {
    const crypto = await createWasmCryptoProvider();
    const server = new FakeServer();
    const alice = await createTestClient(server, crypto, {
      store: new SqliteEngineStore(await migrated()),
    });
    const bob = await createTestClient(server, crypto, {
      store: new SqliteEngineStore(await migrated()),
    });
    try {
      bob.transport.connect();
      await bob.engine.start();
      await alice.engine.start(); // offline: the message waits in the SQLite outbox
      const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
      const first = await alice.engine.sendText(conversationId, 'over sqlite');
      const engine = await alice.restart();
      alice.transport.connect();
      await engine.start();
      await eventually(
        async () =>
          (await alice.store.getMessage(first.messageId))?.state ===
          'delivered_to_recipient_device',
      );
      expect((await bob.store.listMessages(conversationId, { limit: 10 }))[0]?.body).toBe(
        'over sqlite',
      );
      const reply = await bob.engine.sendText(conversationId, 'and back');
      await eventually(async () => (await alice.store.getMessage(reply.messageId)) !== undefined);
      expect(await alice.store.listOutbox()).toEqual([]);
    } finally {
      await alice.engine.stop();
      await bob.engine.stop();
    }
  });
});
