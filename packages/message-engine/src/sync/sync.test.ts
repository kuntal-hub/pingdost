/**
 * History sync between a phone and a linked browser over the in-memory fake server, with real
 * vodozemac (ADR 0021): the window, bounded batches, resume after the browser dies mid-sync,
 * dedupe, the hash check, pause, "load older", groups, the phone being offline, file parts.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { directConversationIdFor, uuidv7 } from '@pingdost/protocol';

import { SyncError } from '../errors';
import type { MemoryEngineStore } from '../memoryStore';
import type { ConversationRecord, GroupRecord, MessageRecord } from '../store';
import { createTestClient, eventually, FakeServer, type TestClient } from '../testing';
import type { HistorySyncState } from './sink';

let crypto: CryptoProvider;
const running: TestClient[] = [];
const DAY = 86_400_000;

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const client of running.splice(0)) await client.engine.stop();
});

type Options = Parameters<typeof createTestClient>[2];

async function client(server: FakeServer, options: Options = {}): Promise<TestClient> {
  const created = await createTestClient(server, crypto, {
    ...(process.env.ENGINE_LOG
      ? { log: (level, message, fields) => console.log(level, message, fields ?? '') }
      : {}),
    ...options,
  });
  running.push(created);
  return created;
}

async function online(...clients: TestClient[]): Promise<void> {
  for (const c of clients) {
    c.transport.connect();
    await c.engine.start();
  }
}

/** A phone and its linked browser (not started). */
async function pair(
  server: FakeServer,
  phoneOptions: Options = {},
  webOptions: Options = {},
): Promise<{ phone: TestClient; web: TestClient }> {
  const phone = await client(server, phoneOptions);
  const web = await client(server, {
    sameUserAs: phone,
    platform: 'web',
    historySync: { autoStart: true, retryMs: [50] },
    ...webOptions,
  });
  return { phone, web };
}

function message(
  conversationId: string,
  senderUserId: string,
  sortAt: number,
  body: string,
  fields: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    messageId: uuidv7(),
    conversationId,
    senderUserId,
    senderDeviceId: uuidv7(),
    direction: 'in',
    kind: 'text',
    body,
    attachment: null,
    replyTo: null,
    sentAt: sortAt,
    sortAt,
    createdAt: sortAt,
    state: null,
    expiresAt: null,
    editedAt: null,
    editId: null,
    deletedAt: null,
    readAt: sortAt,
    reactions: [],
    ...fields,
  };
}

/** `count` messages from `peerUserId` into the phone's store, newest at `newest`. */
async function seed(
  phone: TestClient,
  peerUserId: string,
  count: number,
  options: { newest?: number; stepMs?: number; size?: number } = {},
): Promise<{ conversationId: string; messages: MessageRecord[] }> {
  const newest = options.newest ?? Date.now() - 1_000;
  const step = options.stepMs ?? 60_000;
  const conversationId = directConversationIdFor(phone.userId, peerUserId);
  const messages = Array.from({ length: count }, (_, i) =>
    message(
      conversationId,
      peerUserId,
      newest - i * step,
      `m${i} `.padEnd(options.size ?? 20, 'x'),
    ),
  );
  const existing = await phone.store.getConversation(conversationId);
  const conversation: ConversationRecord = existing ?? {
    conversationId,
    kind: 'direct',
    peerUserId,
    createdAt: newest - count * step,
    updatedAt: newest,
    lastMessageId: messages[0]?.messageId ?? null,
    unreadCount: 0,
    pinnedAt: null,
    archived: false,
    mutedUntil: null,
  };
  await phone.store.apply({ conversations: [conversation], messages });
  return { conversationId, messages };
}

async function until(c: TestClient, state: HistorySyncState, timeoutMs = 10_000): Promise<void> {
  await eventually(
    async () => (await c.engine.historySyncStatus()).state === state,
    timeoutMs,
    `history sync ${state}`,
  );
}

function storeOf(c: TestClient): MemoryEngineStore {
  return c.store;
}

describe('history sync', () => {
  it('sends only the recent window, in bounded batches, and stores nothing on the server', async () => {
    const server = new FakeServer();
    const { phone, web } = await pair(server);
    const now = Date.now();
    const a = await seed(phone, uuidv7(), 150, { size: 400 });
    // 40 to 45 days old: outside the default 30-day window.
    const old = await seed(phone, uuidv7(), 6, { newest: now - 40 * DAY, stepMs: DAY });
    const b = await seed(phone, uuidv7(), 10);
    await online(phone, web);
    await until(web, 'done');

    const stored = storeOf(web).allMessages();
    expect(stored).toHaveLength(160);
    const ids = new Set(stored.map((m) => m.messageId));
    expect(a.messages.every((m) => ids.has(m.messageId))).toBe(true);
    expect(b.messages.every((m) => ids.has(m.messageId))).toBe(true);
    expect(old.messages.some((m) => ids.has(m.messageId))).toBe(false);
    // The conversation of the old messages comes along (empty), so the list matches.
    expect(await web.engine.getConversation(a.conversationId)).toMatchObject({
      kind: 'direct',
      lastMessageId: a.messages[0]!.messageId,
    });
    const status = await web.engine.historySyncStatus();
    expect(status).toMatchObject({ messages: 160, conversationsTotal: 3, conversationsDone: 3 });
    expect(status.recentSyncedAt).not.toBeNull();
    // 150 × ~470 bytes needs more than one 44 KB batch: a request, two or more batches and
    // their acks, and the manifest. Nothing went into a mailbox.
    expect(server.ephemeralRelayed).toBeGreaterThanOrEqual(6);
    expect(server.accepted).toHaveLength(0);
    const sent = await phone.engine.historySendProgress();
    expect(sent).toEqual([
      expect.objectContaining({ deviceId: web.deviceId, state: 'done', messages: 160 }),
    ]);
  });

  it('resumes after the browser is killed mid-sync, without starting over', async () => {
    const server = new FakeServer();
    const logs: string[] = [];
    const { phone, web } = await pair(server, { log: (_level, text) => logs.push(text) });
    const seeded = await seed(phone, uuidv7(), 400, { size: 400 });
    // Two batches reach the browser, then the connection "dies".
    let batches = 0;
    server.ephemeralFilter = (from) => from !== phone.deviceId || ++batches <= 2;
    await online(phone, web);
    // The third batch is lost on the way.
    await eventually(() => batches >= 3, 5_000, 'a lost batch');
    await web.engine.idle();
    const before = (await web.engine.historySyncStatus()).messages;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(400);

    // The tab is killed and opened again.
    web.transport.disconnect();
    await web.restart();
    server.ephemeralFilter = undefined;
    web.transport.connect();
    await web.engine.start();
    await until(web, 'done');

    const stored = storeOf(web).allMessages();
    expect(stored).toHaveLength(400);
    expect(new Set(stored.map((m) => m.messageId)).size).toBe(400);
    expect(seeded.messages.every((m) => stored.some((s) => s.messageId === m.messageId))).toBe(
      true,
    );
    // One sync, resumed: the phone never started it a second time.
    expect(logs.filter((text) => text === 'history sync started')).toHaveLength(1);
  });

  it('skips messages the browser already has, and still passes the manifest check', async () => {
    const server = new FakeServer();
    const { phone, web } = await pair(server);
    const seeded = await seed(phone, uuidv7(), 30);
    // Five of them reached the browser live, one of them already read and edited there.
    const conversation = (await phone.store.getConversation(seeded.conversationId))!;
    const known = seeded.messages
      .slice(0, 5)
      .map((m, i) => (i === 0 ? { ...m, body: 'edited' } : m));
    await web.store.apply({
      conversations: [{ ...conversation, unreadCount: 0 }],
      messages: known,
    });
    await online(phone, web);
    await until(web, 'done');
    expect(storeOf(web).allMessages()).toHaveLength(30);
    expect((await web.engine.getMessage(known[0]!.messageId))?.body).toBe('edited');
    expect((await web.engine.historySyncStatus()).messages).toBe(30);
  });

  it('rejects a batch whose hash does not match, and gets it again', async () => {
    const server = new FakeServer();
    let corrupt = 1;
    const tampered: CryptoProvider = {
      ...crypto,
      sha256: (data) => {
        const digest = crypto.sha256(data);
        if (corrupt-- > 0) digest[0] = (digest[0] ?? 0) ^ 0xff;
        return digest;
      },
    };
    const logs: string[] = [];
    const phone = await createTestClient(server, tampered, {
      log: (_level, text) => logs.push(text),
    });
    running.push(phone);
    const web = await client(server, {
      sameUserAs: phone,
      platform: 'web',
      historySync: { autoStart: true },
    });
    await seed(phone, uuidv7(), 20);
    await online(phone, web);
    await until(web, 'done');
    expect(logs).toContain('history batch rejected; sending it again');
    expect(storeOf(web).allMessages()).toHaveLength(20);
  });

  it('pauses and resumes on request', async () => {
    const server = new FakeServer();
    const { phone, web } = await pair(server);
    await seed(phone, uuidv7(), 300, { size: 400 });
    let batches = 0;
    server.ephemeralFilter = (from) => {
      if (from === phone.deviceId) batches++;
      return true;
    };
    await online(phone, web);
    await eventually(() => batches >= 1);
    await web.engine.pauseHistorySync();
    expect((await web.engine.historySyncStatus()).state).toBe('paused');
    await web.engine.idle();
    const paused = storeOf(web).allMessages().length;
    expect(paused).toBeLessThan(300);
    await eventually(async () =>
      (await phone.engine.historySendProgress()).some((p) => p.state === 'paused'),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(storeOf(web).allMessages()).toHaveLength(paused);

    await web.engine.resumeHistorySync();
    await until(web, 'done');
    expect(storeOf(web).allMessages()).toHaveLength(300);
  });

  it('says the phone is offline, then resumes once it is back', async () => {
    const server = new FakeServer();
    const { phone, web } = await pair(server);
    await seed(phone, uuidv7(), 10);
    await online(web);
    await until(web, 'phone_offline');
    await online(phone);
    await until(web, 'done');
    expect(storeOf(web).allMessages()).toHaveLength(10);
  });

  it('loads older messages of one conversation on request', async () => {
    const server = new FakeServer();
    const { phone, web } = await pair(
      server,
      {},
      { historySync: { autoStart: true, window: { days: 30, maxPerConversation: 50 } } },
    );
    const seeded = await seed(phone, uuidv7(), 400);
    await online(phone, web);
    await until(web, 'done');
    expect(storeOf(web).allMessages()).toHaveLength(50);
    const oldest = seeded.messages[49]!;
    await web.engine.loadOlderFromPhone(seeded.conversationId, {
      sortAt: oldest.sortAt,
      messageId: oldest.messageId,
    });
    await until(web, 'done');
    const stored = storeOf(web).allMessages();
    expect(stored).toHaveLength(250);
    const expected = seeded.messages.slice(0, 250).map((m) => m.messageId);
    expect(stored.map((m) => m.messageId).sort()).toEqual([...expected].sort());
    const status = await web.engine.historySyncStatus();
    expect(status.conversationId).toBe(seeded.conversationId);
  });

  it('brings group state, so the browser can take part in older groups', async () => {
    const server = new FakeServer();
    const { phone, web } = await pair(server);
    const groupId = uuidv7();
    const other = uuidv7();
    const now = Date.now();
    const group: GroupRecord = {
      groupId,
      version: 3,
      members: [
        { userId: phone.userId, role: 'owner' },
        { userId: other, role: 'member' },
      ],
      serverVersion: 3,
      serverMembers: [
        { userId: phone.userId, role: 'owner' },
        { userId: other, role: 'member' },
      ],
      name: 'Trip',
      description: '',
      avatar: null,
      infoAt: now - 5_000,
      infoId: uuidv7(),
      left: false,
      createdAt: now - 10_000,
      updatedAt: now - 5_000,
    };
    const hello = message(groupId, other, now - 2_000, 'hello group');
    await phone.store.apply({
      groups: [group],
      conversations: [
        {
          conversationId: groupId,
          kind: 'group',
          peerUserId: '',
          createdAt: now - 10_000,
          updatedAt: now - 2_000,
          lastMessageId: hello.messageId,
          unreadCount: 0,
          pinnedAt: null,
          archived: false,
          mutedUntil: null,
        },
      ],
      messages: [hello],
    });
    await online(phone, web);
    await until(web, 'done');
    expect(await web.engine.getGroup(groupId)).toMatchObject({ name: 'Trip', version: 3 });
    expect((await web.engine.getMessage(hello.messageId))?.body).toBe('hello group');
  });

  it('refuses a device that is not a linked browser', async () => {
    const server = new FakeServer();
    const phone = await client(server);
    const second = await client(server, {
      sameUserAs: phone,
      historySync: { autoStart: true },
    });
    await seed(phone, uuidv7(), 3);
    await online(phone, second);
    await until(second, 'failed');
    expect((await second.engine.historySyncStatus()).error).toBe('refused');
    expect(storeOf(second).allMessages()).toHaveLength(0);
  });

  it('relays attachment ciphertext from the phone in parts', async () => {
    const server = new FakeServer();
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 251);
    const attachmentId = uuidv7();
    const { phone, web } = await pair(server, {
      historySync: {
        files: {
          read: (id, offset, length) =>
            Promise.resolve(
              id === attachmentId
                ? { data: bytes.slice(offset, offset + length), totalSize: bytes.length }
                : undefined,
            ),
        },
      },
    });
    await online(web);
    await expect(web.engine.fetchFromPhone(attachmentId, 0)).rejects.toMatchObject({
      code: 'phone_offline',
    });
    await online(phone);
    const first = await web.engine.fetchFromPhone(attachmentId, 0);
    expect(first.totalSize).toBe(100_000);
    expect(first.data).toEqual(bytes.slice(0, first.data.length));
    const rest = await web.engine.fetchFromPhone(attachmentId, first.data.length, 100_000);
    expect(first.data.length + rest.data.length).toBeLessThanOrEqual(100_000);
    expect(rest.data).toEqual(bytes.slice(first.data.length, first.data.length + rest.data.length));
    const missing = web.engine.fetchFromPhone(uuidv7(), 0);
    await expect(missing).rejects.toBeInstanceOf(SyncError);
    await expect(missing).rejects.toMatchObject({ code: 'missing' });
  });
});
