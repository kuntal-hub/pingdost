/**
 * The Redis budget spike (Phase 8, ADR 0010): commands per mailbox operation, counted by the
 * app's Redis handle (it matches Valkey's own `total_commands_processed`, MULTI/EXEC and
 * pipelines included). The ceilings stop a change from quietly costing more; the printed
 * numbers feed the ADR's monthly projection.
 */
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { Accepted_Status } from '@pingdost/protocol';

import { cryptoProvider } from './devices';
import { startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket, type TestDeviceSession } from './ws';
import { Metrics } from '../src/infra/metrics';
import { MailboxMigrator } from '../src/modules/delivery/jobs';
import { MongoMailbox } from '../src/modules/delivery/mongo-store';
import { RedisMailbox } from '../src/modules/delivery/redis-store';

const STAGE_MS = 2_000;
const BATCH = 10;

let server: TestServer;
let crypto: CryptoProvider;
const measured: Record<string, number> = {};

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    delivery: { settings: { stageMs: STAGE_MS, onlineAckTimeoutMs: 300 } },
  });
  // The connection handshake (HELLO, CLIENT SETINFO ×2, INFO) happens once per process.
  await server.redis.client().ping();
});

/** Connects and lets the connection's own mailbox fetch finish outside any measurement. */
async function quietSocket(session: TestDeviceSession): Promise<TestSocket> {
  const socket = await TestSocket.connect(server, session);
  await socket.delivered(150);
  return socket;
}

afterAll(async () => {
  process.stdout.write(`REDIS_BUDGET ${JSON.stringify(measured)}\n`);
  process.stdout.write(`CMDS\n${log.join('\n')}\n`);
  await server.close();
});

function migrator(): MailboxMigrator {
  return new MailboxMigrator({
    settings: server.mailbox,
    clock: server.clock,
    metrics: new Metrics({
      redisCommands: () => 0,
      mongoMailbox: () => Promise.resolve({ count: 0, oldestAgeSeconds: 0 }),
    }),
    log: pino({ level: 'silent' }),
    redis: new RedisMailbox(server.redis, server.mailbox.redisKeyPrefix),
    mongo: new MongoMailbox(server.mongo.db),
  });
}

const names: string[] = [];
const log: string[] = [];
let recording = false;

/** Redis commands that `run` sends through the app's handle (names kept for the report). */
async function commands(run: () => Promise<unknown>): Promise<number> {
  const client = server.redis.client() as ReturnType<TestServer['redis']['client']> & {
    recorded?: boolean;
  };
  if (!client.recorded) {
    const send = client.sendCommand.bind(client);
    client.sendCommand = (...args: Parameters<typeof send>) => {
      if (recording) names.push(args[0].name);
      return send(...args);
    };
    client.recorded = true;
  }
  names.length = 0;
  recording = true;
  const before = server.redis.commandCount();
  await run();
  recording = false;
  log.push(names.join(','));
  return server.redis.commandCount() - before;
}

async function sendStored(socket: TestSocket, from: TestDeviceSession, to: TestDeviceSession) {
  const built = envelopePacket(server, from.deviceId, to.deviceId);
  expect(await socket.reply(socket.sendPacket(built.packet))).toMatchObject({
    case: 'accepted',
    value: { status: Accepted_Status.STORED },
  });
  return built.envelopeId;
}

/** Connects, takes every delivery, ACKs them in one frame, and waits for the deletes. */
async function fetchAndAck(session: TestDeviceSession, expected: number) {
  let ids: string[] = [];
  let socket: TestSocket | undefined;
  const fetch = await commands(async () => {
    socket = await TestSocket.connect(server, session);
    ids = await socket.delivered(400);
  });
  expect(ids).toHaveLength(expected);
  const ack = await commands(async () => {
    socket?.ack(ids);
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  socket?.close();
  return { fetch, ack };
}

describe('Redis commands per operation', () => {
  it('offline message staged in Redis: store, fetch, ack', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const socket = await quietSocket(alice);

    measured.storeOne = await commands(() => sendStored(socket, alice, bob));
    const one = await fetchAndAck(bob, 1);
    measured.fetchBatchOf1 = one.fetch;
    measured.ackBatchOf1 = one.ack;

    measured.storeBatchOf10 = await commands(async () => {
      for (let i = 0; i < BATCH; i++) await sendStored(socket, alice, bob);
    });
    const ten = await fetchAndAck(bob, BATCH);
    measured.fetchBatchOf10 = ten.fetch;
    measured.ackBatchOf10 = ten.ack;
    socket.close();

    // MULTI + SET + 2×ZADD + EXEC.
    expect(measured.storeOne).toBeLessThanOrEqual(5);
    // ZRANGE + MGET, plus the empty follow-up ZRANGE that ends the stream.
    expect(measured.fetchBatchOf1).toBeLessThanOrEqual(3);
    // ZMSCORE + MULTI + DEL + 2×ZREM + EXEC, then the stream's ZRANGE that finds no more.
    expect(measured.ackBatchOf1).toBeLessThanOrEqual(7);
    expect(measured.ackBatchOf10).toBeLessThanOrEqual(7);
    expect(measured.storeBatchOf10).toBeLessThanOrEqual(5 * BATCH);
  });

  it('migrated message: migration, then fetch and ack from Mongo', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const socket = await quietSocket(alice);
    await sendStored(socket, alice, bob);
    socket.close();
    // Clear anything earlier tests left due, so the next run moves exactly one envelope.
    server.clock.advance(STAGE_MS + 1);
    await migrator().runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const socket2 = await quietSocket(alice);
    await sendStored(socket2, alice, bob);
    socket2.close();
    server.clock.advance(STAGE_MS + 1);
    let result = { migrated: 0 };
    measured.migrateOne = await commands(async () => {
      result = await migrator().runOnce();
    });
    expect(result.migrated).toBe(1);
    const fetched = await fetchAndAck(bob, 2);
    measured.fetchFromMongo = fetched.fetch;
    measured.ackFromMongo = fetched.ack;

    // ZRANGEBYSCORE + SET lock + GET + MULTI/DEL/2×ZREM/EXEC + the 4-command snapshot.
    expect(measured.migrateOne).toBeLessThanOrEqual(12);
    // Only the ZRANGE that finds the Redis stage empty.
    expect(measured.fetchFromMongo).toBeLessThanOrEqual(2);
    // No Redis delete for Mongo-sourced envelopes: only the stream's final ZRANGE.
    expect(measured.ackFromMongo).toBeLessThanOrEqual(1);
  });

  it('costs nothing on the online path, and little when idle', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const aliceSocket = await quietSocket(alice);
    const bobSocket = await quietSocket(bob);

    measured.online = await commands(async () => {
      const { packet, envelopeId } = envelopePacket(server, alice.deviceId, bob.deviceId);
      const requestId = aliceSocket.sendPacket(packet);
      await bobSocket.next('deliver');
      bobSocket.ack([envelopeId]);
      expect(await aliceSocket.reply(requestId)).toMatchObject({
        case: 'accepted',
        value: { status: Accepted_Status.DELIVERED_TRANSPORT },
      });
    });
    aliceSocket.close();
    bobSocket.close();
    expect(measured.online).toBe(0);

    measured.idleMigrationRun = await commands(() => migrator().runOnce());
    // ZRANGEBYSCORE + the 4-command snapshot.
    expect(measured.idleMigrationRun).toBeLessThanOrEqual(5);
    measured.connectWithEmptyMailbox = await commands(async () => {
      const socket = await TestSocket.connect(server, bob);
      await socket.delivered(200);
      socket.close();
    });
    expect(measured.connectWithEmptyMailbox).toBeLessThanOrEqual(1);
  });
});
