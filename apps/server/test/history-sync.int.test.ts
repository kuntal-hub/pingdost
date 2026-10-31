/**
 * History sync over the real server (Phase 18, ADR 0021): a phone-like sim client with its
 * history, and a browser-like one on the Dexie store, linked by real pairing. The sync runs
 * through the gateway's ephemeral relay while the browser loses its socket, is killed and
 * reopened, and the phone goes offline; it still completes exactly once per message.
 *
 * The server must store none of it: every Redis command and every Mongo write command during
 * the sync is recorded; no Redis command may write and no Mongo command may change a document.
 * An uninterrupted sync uses no Redis at all.
 */
import 'fake-indexeddb/auto';

import type { AddressInfo } from 'node:net';

import type { CommandStartedEvent, CommandSucceededEvent } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import type { ConversationRecord, GroupRecord, MessageRecord } from '@pingdost/message-engine';
import { directConversationIdFor, uuidv7 } from '@pingdost/protocol';
import { SimClient, type SimClientOptions } from '@pingdost/sim-client';
import { DexieEngineStore, PingdostDb, vaultKey } from '@pingdost/web-store';

import { cryptoProvider } from './devices';
import { freePort, MAILPIT_URL, startTestServer, type TestServer } from './helpers';

let crypto: CryptoProvider;
let server: TestServer;
let port = 0;
const clients: SimClient[] = [];

/** Redis commands that only read. Anything else during a sync is a failure. */
const REDIS_READS = new Set(['get', 'mget', 'zrange', 'zrangebyscore', 'zcard', 'exists', 'ping']);
/** Mongo commands that write. */
const MONGO_WRITES = new Set([
  'insert',
  'update',
  'delete',
  'findAndModify',
  'bulkWrite',
  'create',
  'createIndexes',
  'drop',
]);

const redisCommands: string[] = [];
const mongoWrites: string[] = [];
let recording = false;

beforeAll(async () => {
  crypto = await cryptoProvider();
  port = await freePort();
  server = await startTestServer({
    env: { PUBLIC_API_URL: `http://127.0.0.1:${port}` },
    throttles: { keyClaims: { limit: 10_000, windowMs: 3_600_000 } },
    monitorMongo: true,
  });
  await server.app.listen({ host: '127.0.0.1', port });
  port = (server.app.server.address() as AddressInfo).port;
  const redis = server.redis.client();
  const send = redis.sendCommand.bind(redis);
  redis.sendCommand = (...args: Parameters<typeof send>) => {
    if (recording) redisCommands.push(args[0].name.toLowerCase());
    return send(...args);
  };
  // A write command that changes no document (e.g. the coarse last-seen `touch`, which
  // matches only once a day) stores nothing; one that does is recorded.
  const started = new Map<number, string>();
  server.mongo.client.on('commandStarted', (event: CommandStartedEvent) => {
    if (recording && MONGO_WRITES.has(event.commandName)) {
      const target = (event.command as Record<string, unknown>)[event.commandName];
      started.set(event.requestId, `${event.commandName}:${String(target)}`);
    }
  });
  server.mongo.client.on('commandSucceeded', (event: CommandSucceededEvent) => {
    const write = started.get(event.requestId);
    if (!write) return;
    started.delete(event.requestId);
    const reply = event.reply as { n?: number; nModified?: number; upserted?: unknown[] };
    const changed = write.startsWith('update')
      ? (reply.nModified ?? 0) + (reply.upserted?.length ?? 0)
      : (reply.n ?? 1);
    if (changed > 0) mongoWrites.push(write);
  });
});

afterAll(async () => {
  for (const client of clients) await client.stop().catch(() => undefined);
  await server.close();
});

function options(overrides: Partial<SimClientOptions> = {}): SimClientOptions {
  return {
    endpoints: {
      api: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/v1/ws`,
      mailpit: MAILPIT_URL,
    },
    crypto,
    settings: {
      directoryMaxAgeMs: 60_000,
      receiptDelayMs: 50,
      retry: { baseMs: 200, maxMs: 1_000 },
    },
    receipts: () => true,
    ...overrides,
  };
}

async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** History on the phone: `count` long messages with one friend, newest first. */
async function seedHistory(phone: SimClient, count: number) {
  const friend = uuidv7();
  const conversationId = directConversationIdFor(phone.userId, friend);
  const now = Date.now();
  const messages: MessageRecord[] = Array.from({ length: count }, (_, i) => ({
    messageId: uuidv7(),
    conversationId,
    senderUserId: i % 3 === 0 ? phone.userId : friend,
    senderDeviceId: i % 3 === 0 ? phone.deviceId : uuidv7(),
    direction: i % 3 === 0 ? 'out' : 'in',
    kind: 'text',
    body: `message ${i}: `.padEnd(1_000, 'lorem ipsum '),
    attachment: null,
    replyTo: null,
    sentAt: now - (i + 1) * 60_000,
    sortAt: now - (i + 1) * 60_000,
    createdAt: now - (i + 1) * 60_000,
    state: i % 3 === 0 ? 'read' : null,
    expiresAt: null,
    editedAt: null,
    editId: null,
    deletedAt: null,
    readAt: now,
    reactions: [],
  }));
  const conversation: ConversationRecord = {
    conversationId,
    kind: 'direct',
    peerUserId: friend,
    createdAt: now - count * 60_000,
    updatedAt: now - 60_000,
    lastMessageId: messages[0]!.messageId,
    unreadCount: 0,
    pinnedAt: null,
    archived: false,
    mutedUntil: null,
  };
  const groupId = uuidv7();
  const group: GroupRecord = {
    groupId,
    version: 2,
    members: [
      { userId: phone.userId, role: 'owner' },
      { userId: friend, role: 'member' },
    ],
    serverVersion: 2,
    serverMembers: [
      { userId: phone.userId, role: 'owner' },
      { userId: friend, role: 'member' },
    ],
    name: 'Sync test group',
    description: '',
    avatar: null,
    infoAt: now - 100_000,
    infoId: uuidv7(),
    left: false,
    createdAt: now - 200_000,
    updatedAt: now - 100_000,
  };
  await phone.store.apply({
    conversations: [
      conversation,
      {
        ...conversation,
        conversationId: groupId,
        kind: 'group',
        peerUserId: '',
        lastMessageId: null,
      },
    ],
    messages,
    groups: [group],
  });
  return { conversationId, groupId, messages };
}

describe('history sync over the ephemeral relay', () => {
  it('survives disconnects on both sides, stores each message once, and writes nothing on the server', async () => {
    const phone = await SimClient.register(options());
    const history = await seedHistory(phone, 240);
    const db = new PingdostDb(`history-int-${Date.now()}`);
    const store = new DexieEngineStore(db, await vaultKey(db));
    const browserOptions = options({ store, historySync: { autoStart: false, retryMs: [300] } });
    const browser = await SimClient.linkedDevice(browserOptions, phone, 'Chrome on Windows');
    clients.push(phone, browser);
    await phone.start();
    await browser.start();
    await phone.engine.refreshDevices(phone.userId);
    // Opens the Olm session between the two (a one-time key claim, a Mongo write) before
    // recording starts: the phone has no such file and says so.
    await expect(browser.engine.fetchFromPhone(uuidv7(), 0)).rejects.toMatchObject({
      code: 'missing',
    });

    recording = true;
    await browser.engine.syncHistory();
    const status = () => browser.engine.historySyncStatus();

    // 1. The browser's socket drops after the first batch, then comes back.
    await until(async () => (await status()).messages > 0, 'the first batch');
    browser.transport.stop();
    await until(async () => (await status()).state === 'offline', 'offline status');
    browser.transport.start();

    // 2. The tab is killed and reopened on the same IndexedDB.
    const progressed = (await status()).messages;
    await until(async () => (await status()).messages > progressed, 'more batches');
    await browser.restart();

    // 3. The phone goes offline: the browser says so, then resumes by itself.
    await until(async () => (await status()).messages > 0, 'the stored progress is back');
    phone.transport.stop();
    await until(async () => (await status()).state === 'phone_offline', 'phone offline status');
    phone.transport.start();

    await until(async () => (await status()).state === 'done', 'the sync to finish', 60_000);
    recording = false;

    const synced = await browser.engine.listMessages(history.conversationId, { limit: 500 });
    expect(synced).toHaveLength(240);
    expect(new Set(synced.map((m) => m.messageId)).size).toBe(240);
    expect(synced.map((m) => m.messageId).sort()).toEqual(
      history.messages.map((m) => m.messageId).sort(),
    );
    const own = synced.find((m) => m.senderUserId === phone.userId);
    expect(own).toMatchObject({ direction: 'out', state: 'read' });
    expect(await browser.engine.getGroup(history.groupId)).toMatchObject({
      name: 'Sync test group',
    });
    expect((await status()).recentSyncedAt).not.toBeNull();

    // Nothing written on the server: reconnects only read the (empty) mailbox.
    expect(mongoWrites).toEqual([]);
    expect(redisCommands.filter((name) => !REDIS_READS.has(name))).toEqual([]);
    // The phone's group check found the (local-only) test group unknown to the server and
    // added a notice: 241 messages in all, every one of them synced.
    const all = phone.store.allMessages().length;
    expect(all).toBe(241);
    const phoneSide = await phone.engine.historySendProgress();
    expect(phoneSide).toEqual([
      expect.objectContaining({ deviceId: browser.deviceId, state: 'done', messages: all }),
    ]);

    // An uninterrupted sync ("load older", nothing older here) uses no Redis at all.
    redisCommands.length = 0;
    recording = true;
    const oldest = synced.at(-1)!;
    await browser.engine.loadOlderFromPhone(history.conversationId, {
      sortAt: oldest.sortAt,
      messageId: oldest.messageId,
    });
    await until(async () => (await status()).state === 'done', 'the older-messages sync');
    await browser.engine.syncHistory();
    await until(async () => (await status()).state === 'done', 'a second full sync');
    recording = false;
    expect(redisCommands).toEqual([]);
    expect(mongoWrites).toEqual([]);
    expect(await browser.engine.listMessages(history.conversationId, { limit: 500 })).toHaveLength(
      240,
    );
  }, 120_000);
});
