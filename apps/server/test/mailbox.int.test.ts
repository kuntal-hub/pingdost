/**
 * The delivery mailbox against REQ §19.2 (Phase 8 scenarios 1–9). The migration and reaper
 * run directly here (the scheduler only adds a lease and an interval), and the test clock
 * stands in for the 14-hour stage and the 14-day retention.
 */
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { Accepted_Status } from '@pingdost/protocol';

import { cryptoProvider } from './devices';
import { startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket, type TestDeviceSession } from './ws';
import { Metrics } from '../src/infra/metrics';
import { MailboxMigrator, MailboxReaper } from '../src/modules/delivery/jobs';
import {
  MongoMailbox,
  PENDING_ENVELOPES,
  type MongoMailboxStore,
  type PendingEnvelopeDoc,
} from '../src/modules/delivery/mongo-store';
import { RedisMailbox } from '../src/modules/delivery/redis-store';

const STAGE_MS = 2_000;
const RETENTION_MS = 60_000;
const LOCK_MS = 300;

let server: TestServer;
let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    delivery: {
      settings: {
        stageMs: STAGE_MS,
        graceMs: 9_000,
        retentionMs: RETENTION_MS,
        onlineAckTimeoutMs: 300,
        migrationLockMs: LOCK_MS,
      },
    },
  });
});

afterAll(async () => {
  await server.close();
});

// Store and job helpers

function redisMailbox(target = server): RedisMailbox {
  return new RedisMailbox(target.redis, target.mailbox.redisKeyPrefix);
}

function jobs(mongo: MongoMailboxStore = new MongoMailbox(server.mongo.db)) {
  const deps = {
    settings: server.mailbox,
    clock: server.clock,
    metrics: new Metrics({
      redisCommands: () => 0,
      mongoMailbox: () => Promise.resolve({ count: 0, oldestAgeSeconds: 0 }),
    }),
    log: pino({ level: 'silent' }),
    redis: redisMailbox(),
    mongo,
  };
  return { migrator: new MailboxMigrator(deps), reaper: new MailboxReaper(deps) };
}

/** A Mongo store with hooks around the real one. */
function mongoWith(overrides: Partial<MongoMailboxStore>, target = server): MongoMailboxStore {
  const real = new MongoMailbox(target.mongo.db);
  return {
    insert: (record, at) => real.insert(record, at),
    has: (id) => real.has(id),
    list: (device, now, limit) => real.list(device, now, limit),
    remove: (device, ids) => real.remove(device, ids),
    removeOne: (id) => real.removeOne(id),
    removeExpired: (now) => real.removeExpired(now),
    stats: (now) => real.stats(now),
    ...overrides,
  };
}

function pending(target = server) {
  return target.mongo.db.collection<PendingEnvelopeDoc>(PENDING_ENVELOPES);
}

async function inRedis(envelopeId: string, recipient: string, target = server) {
  const prefix = target.mailbox.redisKeyPrefix;
  const client = target.redis.client();
  return {
    env: (await client.exists(`${prefix}env:${envelopeId}`)) === 1,
    mbx: await client.zscore(`${prefix}mbx:${recipient}`, envelopeId),
    due: await client.zscore(`${prefix}due`, envelopeId),
  };
}

async function gone(envelopeId: string, recipient: string, target = server) {
  expect(await inRedis(envelopeId, recipient, target)).toEqual({
    env: false,
    mbx: null,
    due: null,
  });
  expect(await pending(target).countDocuments({ _id: envelopeId })).toBe(0);
}

/** Alice (connected) and Bob (offline): a sender socket and the recipient's session. */
async function senderAndOfflineRecipient(target = server) {
  const alice = await deviceSession(target, crypto);
  const bob = await deviceSession(target, crypto);
  return { alice, bob, socket: await TestSocket.connect(target, alice) };
}

async function sendStored(
  socket: TestSocket,
  from: TestDeviceSession,
  to: TestDeviceSession,
  options: Parameters<typeof envelopePacket>[3] = {},
  target = server,
) {
  const built = envelopePacket(target, from.deviceId, to.deviceId, options);
  const reply = await socket.reply(socket.sendPacket(built.packet));
  expect(reply).toMatchObject({ case: 'accepted', value: { status: Accepted_Status.STORED } });
  return built;
}

/** Connects the recipient and returns what arrives within `windowMs`. */
async function fetchAs(session: TestDeviceSession, windowMs = 400, target = server) {
  const socket = await TestSocket.connect(target, session);
  return { socket, delivered: await socket.delivered(windowMs) };
}

describe('mailbox (REQ §19.2)', () => {
  it('1. stages an offline recipient’s envelope in Redis', async () => {
    const { alice, bob, socket } = await senderAndOfflineRecipient();
    const before = server.clock.now();
    const { envelopeId } = await sendStored(socket, alice, bob);

    const staged = await inRedis(envelopeId, bob.deviceId);
    expect(staged.env).toBe(true);
    const createdAt = Number(staged.mbx);
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(Number(staged.due)).toBe(createdAt + STAGE_MS);
    expect(await pending().countDocuments({ _id: envelopeId })).toBe(0);
    socket.close();
  });

  it('2. migrates at the stage boundary and drops Redis only after the verified Mongo write', async () => {
    const { alice, bob, socket } = await senderAndOfflineRecipient();
    const { envelopeId } = await sendStored(socket, alice, bob);
    const createdAt = Number((await inRedis(envelopeId, bob.deviceId)).mbx);

    expect((await jobs().migrator.runOnce()).migrated).toBe(0);
    server.clock.advance(STAGE_MS + 1);

    const redisAtVerify: boolean[] = [];
    const real = new MongoMailbox(server.mongo.db);
    const store = mongoWith({
      has: async (id) => {
        redisAtVerify.push((await inRedis(id, bob.deviceId)).env);
        return real.has(id);
      },
    });
    // Other tests' envelopes may be due too: check this one, and that every verify ran
    // while the Redis copy still existed.
    const result = await jobs(store).migrator.runOnce();
    expect(result.failed).toBe(0);
    expect(redisAtVerify.length).toBeGreaterThanOrEqual(1);
    expect(redisAtVerify.every(Boolean)).toBe(true);

    const doc = await pending().findOne({ _id: envelopeId });
    expect(doc?.createdAt.getTime()).toBe(createdAt);
    expect(doc?.expiresAt.getTime()).toBe(createdAt + RETENTION_MS);
    expect(doc?.stageChangedAt.getTime()).toBeGreaterThan(createdAt);
    expect(await inRedis(envelopeId, bob.deviceId)).toEqual({ env: false, mbx: null, due: null });
    socket.close();
  });

  it('3. keeps the Redis copy while Mongo is down, and a retry migrates it without loss', async () => {
    const { alice, bob, socket } = await senderAndOfflineRecipient();
    const { envelopeId } = await sendStored(socket, alice, bob);
    server.clock.advance(STAGE_MS + 1);

    const down = mongoWith({ insert: () => Promise.reject(new Error('mongo unavailable')) });
    expect(await jobs(down).migrator.runOnce()).toMatchObject({ migrated: 0, failed: 1 });
    expect((await inRedis(envelopeId, bob.deviceId)).env).toBe(true);
    expect(await pending().countDocuments({ _id: envelopeId })).toBe(0);

    expect(await jobs().migrator.runOnce()).toMatchObject({ migrated: 1, failed: 0 });
    const { socket: bobSocket, delivered } = await fetchAs(bob);
    expect(delivered).toEqual([envelopeId]);
    socket.close();
    bobSocket.close();
  });

  it('4. a delivery racing the migration gives one logical delivery and no leftovers', async () => {
    const { alice, bob, socket } = await senderAndOfflineRecipient();

    // a) Fetched from Redis, migrated before the ACK arrives.
    const first = await sendStored(socket, alice, bob);
    const fetched = await fetchAs(bob);
    expect(fetched.delivered).toEqual([first.envelopeId]);
    server.clock.advance(STAGE_MS + 1);
    expect((await jobs().migrator.runOnce()).migrated).toBe(1);
    fetched.socket.ack([first.envelopeId]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await gone(first.envelopeId, bob.deviceId);

    // b) The ACK lands between the Mongo write and the Redis delete.
    const second = await sendStored(socket, alice, bob, {}, server);
    const seen = await fetched.socket.delivered(300);
    expect(seen).toEqual([second.envelopeId]);
    server.clock.advance(STAGE_MS + 1);
    const real = new MongoMailbox(server.mongo.db);
    const racing = mongoWith({
      insert: async (record, at) => {
        await real.insert(record, at);
        fetched.socket.ack([record.envelopeId]);
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      has: () => Promise.resolve(true),
    });
    expect((await jobs(racing).migrator.runOnce()).migrated).toBe(1);
    await gone(second.envelopeId, bob.deviceId);

    // Nothing is delivered again.
    fetched.socket.close();
    expect((await fetchAs(bob)).delivered).toEqual([]);
    socket.close();
  });

  it('5. an ACK removes the envelope from both stores and it is no longer fetchable', async () => {
    const { alice, bob, socket } = await senderAndOfflineRecipient();
    const migrated = await sendStored(socket, alice, bob);
    server.clock.advance(STAGE_MS + 1);
    expect((await jobs().migrator.runOnce()).migrated).toBe(1);
    const staged = await sendStored(socket, alice, bob);

    const first = await fetchAs(bob);
    // Oldest first: the migrated envelope, then the staged one.
    expect(first.delivered).toEqual([migrated.envelopeId, staged.envelopeId]);
    first.socket.ack([migrated.envelopeId, staged.envelopeId]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await gone(migrated.envelopeId, bob.deviceId);
    await gone(staged.envelopeId, bob.deviceId);

    first.socket.close();
    expect((await fetchAs(bob)).delivered).toEqual([]);
    socket.close();
  });

  it('6. expiry is absolute from creation, not from migration', async () => {
    const { alice, bob, socket } = await senderAndOfflineRecipient();
    const { envelopeId } = await sendStored(socket, alice, bob);
    const createdAt = Number((await inRedis(envelopeId, bob.deviceId)).mbx);

    // Migrated late, after most of the retention period.
    server.clock.advance(RETENTION_MS - 5_000);
    expect((await jobs().migrator.runOnce()).migrated).toBe(1);
    expect((await pending().findOne({ _id: envelopeId }))?.expiresAt.getTime()).toBe(
      createdAt + RETENTION_MS,
    );

    const { reaper } = jobs();
    await reaper.runOnce();
    expect(await pending().countDocuments({ _id: envelopeId })).toBe(1);
    server.clock.advance(5_001);
    await reaper.runOnce();
    await gone(envelopeId, bob.deviceId);
    expect((await fetchAs(bob)).delivered).toEqual([]);

    // A packet that expires before its stage ends is deleted, not migrated.
    const shortLived = await sendStored(socket, alice, bob, { ttlMs: 1_000 });
    server.clock.advance(1_001);
    expect(await jobs().migrator.runOnce()).toMatchObject({ migrated: 0, expired: 1 });
    await gone(shortLived.envelopeId, bob.deviceId);
    socket.close();
  });

  it('7. a worker restart mid-migration resumes safely', async () => {
    const { alice, bob, socket } = await senderAndOfflineRecipient();
    const { envelopeId } = await sendStored(socket, alice, bob);
    server.clock.advance(STAGE_MS + 1);

    // The crashed worker wrote Mongo, then died holding the lock, before deleting Redis.
    const record = await redisMailbox().get(envelopeId);
    if (!record) throw new Error('not staged');
    const crashedAt = server.clock.now() - 1_000;
    await new MongoMailbox(server.mongo.db).insert(record, crashedAt);
    expect(await redisMailbox().lock(envelopeId, LOCK_MS)).toBe(true);

    // The restarted worker skips the locked envelope, then finishes once the lock expires.
    expect((await jobs().migrator.runOnce()).migrated).toBe(0);
    expect((await inRedis(envelopeId, bob.deviceId)).env).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, LOCK_MS + 50));
    expect((await jobs().migrator.runOnce()).migrated).toBe(1);

    // One copy, still the first write ( left it alone).
    expect(await pending().countDocuments({ _id: envelopeId })).toBe(1);
    expect((await pending().findOne({ _id: envelopeId }))?.stageChangedAt.getTime()).toBe(
      crashedAt,
    );
    expect((await inRedis(envelopeId, bob.deviceId)).env).toBe(false);
    expect((await fetchAs(bob)).delivered).toEqual([envelopeId]);
    socket.close();
  });

  it('9. a duplicate send keeps a single stored copy', async () => {
    const { alice, bob, socket } = await senderAndOfflineRecipient();
    const first = await sendStored(socket, alice, bob);
    // A retransmit: same message, so the same envelope ID, in a new packet.
    const again = await sendStored(socket, alice, bob, { messageId: first.messageId });
    expect(again.envelopeId).toBe(first.envelopeId);
    const prefix = server.mailbox.redisKeyPrefix;
    expect(await server.redis.client().zcard(`${prefix}mbx:${bob.deviceId}`)).toBe(1);

    server.clock.advance(STAGE_MS + 1);
    expect((await jobs().migrator.runOnce()).migrated).toBe(1);
    await sendStored(socket, alice, bob, { messageId: first.messageId });
    expect(await server.redis.client().zcard(`${prefix}mbx:${bob.deviceId}`)).toBe(0);
    expect(await pending().countDocuments({ recipientDeviceId: bob.deviceId })).toBe(1);

    expect((await fetchAs(bob)).delivered).toEqual([first.envelopeId]);
    socket.close();
  });
});

describe('mailbox without Redis (REQ §19.2, scenario 8)', () => {
  it('8. writes to Mongo when Redis is down, and fails retryably when both are', async () => {
    const deadRedis = { env: { REDIS_URL: 'redis://127.0.0.1:6399' } };
    const noRedis = await startTestServer(deadRedis);
    try {
      const { alice, bob, socket } = await senderAndOfflineRecipient(noRedis);
      const before = noRedis.clock.now();
      const { envelopeId } = await sendStored(socket, alice, bob, {}, noRedis);
      const doc = await pending(noRedis).findOne({ _id: envelopeId });
      expect(doc?.stageChangedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(doc?.expiresAt.getTime()).toBe(
        doc ? doc.createdAt.getTime() + noRedis.mailbox.retentionMs : 0,
      );

      const fetched = await fetchAs(bob, 3_000, noRedis);
      expect(fetched.delivered).toEqual([envelopeId]);
      fetched.socket.ack([envelopeId]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await pending(noRedis).countDocuments({ _id: envelopeId })).toBe(0);
      fetched.socket.close();
      socket.close();
    } finally {
      await noRedis.close();
    }

    const nothing = await startTestServer({
      ...deadRedis,
      delivery: {
        mongoStore: mongoWith({
          has: () => Promise.reject(new Error('mongo unavailable')),
          insert: () => Promise.reject(new Error('mongo unavailable')),
        }),
      },
    });
    try {
      const alice = await deviceSession(nothing, crypto);
      const bob = await deviceSession(nothing, crypto);
      const socket = await TestSocket.connect(nothing, alice);
      const { packet } = envelopePacket(nothing, alice.deviceId, bob.deviceId);
      expect(await socket.reply(socket.sendPacket(packet), 10_000)).toMatchObject({
        case: 'error',
        value: { code: 'MAILBOX_UNAVAILABLE', retryable: true },
      });
      socket.close();
    } finally {
      await nothing.close();
    }
  });
});
