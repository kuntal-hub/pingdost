/**
 * The message engine through the real server (Phase 9): headless sim clients with real E2EE
 * (vodozemac via WASM), the gateway WebSocket and the mailbox, on a listening port.
 * 1. online exchange; 2. offline recipient, then online; 3. reconnect mid-send; 4. duplicate
 * Deliver frames; 5. server restart during the outbox; 6. the recipient adds a device;
 * 7. the recipient revokes a device; 8. ciphertext only in Redis, Mongo and WS frames
 * (REQ §19.1 bullets 1–2); 9. an attachment: encrypted, staged, sent as an E2EE manifest,
 * downloaded, decrypted and acknowledged (Phase 14).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BSON } from 'mongodb';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attachmentsApi, devicesApi } from '@pingdost/api-client';
import {
  buildManifest,
  decryptStream,
  encryptStream,
  uploadAttachment,
  type EncryptedAttachment,
} from '@pingdost/attachments';
import { loadServerConfig } from '@pingdost/config';
import type { CryptoProvider } from '@pingdost/crypto';
import { attachmentDecryptInput } from '@pingdost/message-engine';
import { decodeServerFrame, uuidv7 } from '@pingdost/protocol';
import type { AuthTokens } from '@pingdost/shared-types';
import {
  capturingSocket,
  containsMarker,
  SimClient,
  type NewDeviceKeys,
  type SimClientOptions,
} from '@pingdost/sim-client';
import type { WebSocketFactory, WebSocketLike } from '@pingdost/transport';

import { cryptoProvider } from './devices';
import { freePort, json, MAILPIT_URL, startTestServer, type TestServer } from './helpers';
import { setupIndexes } from '../src/app';
import { Metrics } from '../src/infra/metrics';
import { createMongo, type Mongo } from '../src/infra/mongo';
import { MailboxMigrator } from '../src/modules/delivery/jobs';
import { MongoMailbox } from '../src/modules/delivery/mongo-store';
import { RedisMailbox } from '../src/modules/delivery/redis-store';
import type { MailboxSettings } from '../src/modules/delivery/settings';
import type { DeviceDoc } from '../src/modules/device/repo';

const STAGE_MS = 2_000;
const MARKER = `PLAINTEXT-MARKER-${randomUUID()}`;

let crypto: CryptoProvider;
let mongo: Mongo;
let server: TestServer;
let mailbox: Partial<MailboxSettings> = { stageMs: STAGE_MS, graceMs: 9_000 };
let port = 0;
/** The `fs` attachment staging directory. */
let staging = '';
/** Every WebSocket frame any client sent or received. */
const frames: Uint8Array[] = [];
const clients: SimClient[] = [];

/** Starts (or restarts) the server on the same port, Mongo database and Redis key space. */
async function boot(): Promise<void> {
  server = await startTestServer({
    mongo,
    env: { PUBLIC_API_URL: `http://127.0.0.1:${port}`, ATTACHMENT_FS_ROOT: staging },
    delivery: { settings: mailbox },
    throttles: { keyClaims: { limit: 10_000, windowMs: 3_600_000 } },
  });
  mailbox = server.mailbox;
  await server.app.listen({ host: '127.0.0.1', port });
  port = (server.app.server.address() as AddressInfo).port;
}

beforeAll(async () => {
  crypto = await cryptoProvider();
  // Signed attachment URLs name the server's own origin, so the port is fixed up front.
  port = await freePort();
  staging = await mkdtemp(join(tmpdir(), 'pingdost-engine-staging-'));
  const config = loadServerConfig({
    NODE_ENV: 'test',
    ...(process.env.MONGODB_URI ? { MONGODB_URI: process.env.MONGODB_URI } : {}),
  });
  mongo = createMongo(config.MONGODB_URI, { dbName: `pingdost_test_${randomUUID().slice(0, 8)}` });
  await setupIndexes(mongo);
  await boot();
});

afterAll(async () => {
  for (const client of clients) await client.stop().catch(() => undefined);
  await server.close();
  await mongo.db.dropDatabase();
  await mongo.close();
  await rm(staging, { recursive: true, force: true });
});

function options(overrides: Partial<SimClientOptions> = {}): SimClientOptions {
  return {
    endpoints: {
      api: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/v1/ws`,
      mailpit: MAILPIT_URL,
    },
    crypto,
    // Refetch directories before every fan-out, so a new device is seen at once.
    settings: { directoryMaxAgeMs: 0, receiptDelayMs: 50, retry: { baseMs: 200, maxMs: 1_000 } },
    createSocket: capturingSocket(frames),
    ...overrides,
  };
}

async function sim(overrides: Partial<SimClientOptions> = {}): Promise<SimClient> {
  const client = await SimClient.register(options(overrides));
  clients.push(client);
  return client;
}

async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function send(from: SimClient, to: SimClient, texts: string[]): Promise<string[]> {
  const { conversationId } = await from.engine.openDirectConversation(to.userId);
  const ids: string[] = [];
  for (const text of texts) ids.push((await from.engine.sendText(conversationId, text)).messageId);
  return ids;
}

async function allIn(client: SimClient, ids: string[], state: string): Promise<boolean> {
  for (const id of ids) if ((await client.engine.getMessage(id))?.state !== state) return false;
  return true;
}

function received(client: SimClient, ids: string[]): number {
  return client.store.allMessages().filter((m) => ids.includes(m.messageId)).length;
}

function texts(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${MARKER} ${prefix} #${i}`);
}

/** Sockets a client created, so a test can drop one. */
function recording(list: WebSocketLike[], inner: WebSocketFactory = capturingSocket(frames)) {
  return (url: string) => {
    const socket = inner(url);
    list.push(socket);
    return socket;
  };
}

/** Hands every `Deliver` frame to the transport twice. */
function duplicatingDeliver(inner: WebSocketFactory = capturingSocket(frames)): WebSocketFactory {
  return (url) => {
    const socket = inner(url) as unknown as WebSocket;
    socket.addEventListener('message', (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      if (decodeServerFrame(new Uint8Array(event.data)).body.case !== 'deliver') return;
      (socket as unknown as WebSocketLike).onmessage?.({ data: event.data });
    });
    return socket as unknown as WebSocketLike;
  };
}

/**
 * A linked device for `owner`, bound out of band until QR pairing exists (Phase 16): a fresh
 * password session, the device record, then a refresh for tokens carrying the device.
 */
async function bindLinkedDevice(owner: SimClient, keys: NewDeviceKeys): Promise<AuthTokens> {
  const login = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { identifier: owner.username, password: owner.password },
  });
  const { tokens } = json<{ tokens: AuthTokens }>(login);
  const sessions = mongo.db.collection<{
    _id: string;
    userId: string;
    deviceId: string | null;
    createdAt: Date;
  }>('sessions');
  const session = await sessions.findOne(
    { userId: owner.userId, deviceId: null },
    { sort: { createdAt: -1 } },
  );
  if (!session) throw new Error('no fresh session');
  const now = new Date();
  await mongo.db.collection<DeviceDoc>('devices').insertOne({
    _id: keys.deviceId,
    userId: owner.userId,
    platform: 'web',
    role: 'linked',
    name: 'linked sim',
    identityKeys: keys.identityKeys,
    deviceCertificate: keys.deviceCertificate,
    fallbackKey: null,
    keyVersion: 1,
    status: 'active',
    createdAt: now,
    revokedAt: null,
    lastSeenAt: now,
  });
  await mongo.db
    .collection('users')
    .updateOne({ _id: owner.userId as never }, { $inc: { keyVersion: 1 } });
  await sessions.updateOne({ _id: session._id }, { $set: { deviceId: keys.deviceId } });
  const refreshed = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refreshToken: tokens.refreshToken },
  });
  return json<AuthTokens>(refreshed);
}

describe('message engine through the real server', () => {
  let alice: SimClient;
  let bob: SimClient;

  it('1. exchanges messages online, delivered only after E2EE receipts', async () => {
    alice = await sim();
    bob = await sim();
    await alice.start();
    await bob.start();
    const ids = await send(alice, bob, texts('online', 5));
    await until(() => allIn(alice, ids, 'delivered_to_recipient_device'), 'receipts');
    expect(received(bob, ids)).toBe(5);
    const [reply] = await send(bob, alice, ['reply']);
    await until(() => allIn(bob, [reply!], 'delivered_to_recipient_device'), 'reply receipt');
    expect((await alice.engine.getMessage(reply!))?.body).toBe('reply');
  });

  it('2. queues on the server for an offline recipient', async () => {
    await bob.stop();
    const ids = await send(alice, bob, texts('offline', 5));
    await until(() => allIn(alice, ids, 'sent_to_server'), 'sent_to_server');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await allIn(alice, ids, 'sent_to_server')).toBe(true); // not delivered while offline
    await bob.start();
    await until(
      () => allIn(alice, ids, 'delivered_to_recipient_device'),
      'receipts after reconnect',
    );
    expect(received(bob, ids)).toBe(5);
  });

  it('3. survives a reconnect mid-send without duplicates', async () => {
    const sockets: WebSocketLike[] = [];
    const carol = await sim({ createSocket: recording(sockets) });
    await carol.start();
    const { conversationId } = await carol.engine.openDirectConversation(bob.userId);
    const ids: string[] = [];
    for (const [i, text] of texts('reconnect', 30).entries()) {
      ids.push((await carol.engine.sendText(conversationId, text)).messageId);
      if (i === 12) sockets.at(-1)?.close(); // the connection drops with sends in flight
    }
    await until(() => allIn(carol, ids, 'delivered_to_recipient_device'), 'all delivered', 25_000);
    expect(sockets.length).toBeGreaterThan(1);
    expect(received(bob, ids)).toBe(30);
    expect(new Set(bob.store.allMessages().map((m) => m.messageId)).size).toBe(
      bob.store.allMessages().length,
    );
  });

  it('4. shows one message for duplicate Deliver frames', async () => {
    const dave = await sim({ createSocket: duplicatingDeliver() });
    await dave.start();
    const ids = await send(alice, dave, texts('duplicate', 5));
    await until(() => allIn(alice, ids, 'delivered_to_recipient_device'), 'receipts');
    await dave.engine.idle();
    expect(dave.store.allMessages()).toHaveLength(5);
    const { conversationId } = await dave.engine.openDirectConversation(alice.userId);
    expect((await dave.engine.getConversation(conversationId))?.unreadCount).toBe(5);
  });

  it('5. loses nothing when the server restarts during the outbox', async () => {
    await bob.stop();
    const before = await send(alice, bob, texts('before restart', 5));
    await until(() => allIn(alice, before, 'sent_to_server'), 'stored before the restart');
    await server.close();
    const during = await send(alice, bob, texts('while down', 5));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await allIn(alice, during, 'local_queued')).toBe(true);
    await boot();
    await until(() => allIn(alice, during, 'sent_to_server'), 'sent after the restart', 20_000);
    await bob.start();
    const all = [...before, ...during];
    await until(() => allIn(alice, all, 'delivered_to_recipient_device'), 'receipts', 20_000);
    expect(received(bob, all)).toBe(10);
  });

  let bob2: SimClient;

  it("6. sends new messages to the recipient's new device, and not old ones", async () => {
    const old = await send(alice, bob, ['before the new device']);
    await until(() => received(bob, old) === 1, 'old message');
    bob2 = await SimClient.linkedDevice(options(), bob, (keys) => bindLinkedDevice(bob, keys));
    clients.push(bob2);
    await bob2.start();
    const fresh = await send(alice, bob, texts('two devices', 3));
    await until(() => received(bob2, fresh) === 3, 'the new device gets new messages');
    await until(() => received(bob, fresh) === 3, 'the old device too');
    expect(received(bob2, old)).toBe(0);
    const info = await alice.engine.messageInfo(fresh[0]!);
    expect(info?.deliveries.map((d) => d.deviceId).sort()).toEqual(
      [bob.deviceId, bob2.deviceId].sort(),
    );
  });

  it('7. sends nothing to a revoked device', async () => {
    await devicesApi(bob.api).revoke(bob2.deviceId);
    await until(() => bob2.transport.status === 'offline', 'the revoked socket closes');
    const ids = await send(alice, bob, texts('after revoke', 3));
    await until(() => allIn(alice, ids, 'delivered_to_recipient_device'), 'receipts');
    for (const id of ids) {
      const info = await alice.engine.messageInfo(id);
      expect(info?.deliveries.map((d) => d.deviceId)).toEqual([bob.deviceId]);
    }
    const redis = new RedisMailbox(server.redis, server.mailbox.redisKeyPrefix);
    expect((await redis.list(bob2.deviceId, 100)).records).toEqual([]);
    expect(
      await mongo.db
        .collection('pending_envelopes')
        .countDocuments({ recipientDeviceId: bob2.deviceId }),
    ).toBe(0);
  });

  it('8. leaves only ciphertext in Redis, Mongo and WebSocket frames', async () => {
    await bob.stop();
    const ids = await send(alice, bob, texts('at rest', 5));
    await until(() => allIn(alice, ids, 'sent_to_server'), 'stored');
    // Move some of them to Mongo, so both stores hold envelopes.
    server.clock.advance(STAGE_MS + 1);
    const migrator = new MailboxMigrator({
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
    expect((await migrator.runOnce()).migrated).toBeGreaterThan(0);
    await send(alice, bob, texts('staged', 2)); // and some in Redis
    await new Promise((resolve) => setTimeout(resolve, 300));

    const redis = server.redis.client();
    let redisValues = 0;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${server.mailbox.redisKeyPrefix}*`,
        'COUNT',
        '500',
      );
      cursor = next;
      for (const key of keys) {
        const type = await redis.type(key);
        const values: Buffer[] =
          type === 'string'
            ? [(await redis.getBuffer(key))!]
            : type === 'zset'
              ? await redis.zrangeBuffer(key, '0', '-1')
              : [];
        for (const value of values) {
          redisValues++;
          expect(containsMarker(new Uint8Array(value), MARKER)).toBe(false);
        }
      }
    } while (cursor !== '0');
    expect(redisValues).toBeGreaterThan(0);

    let mongoDocs = 0;
    for (const { name } of await mongo.db.listCollections().toArray()) {
      for await (const doc of mongo.db.collection(name).find()) {
        mongoDocs++;
        expect(containsMarker(BSON.serialize(doc), MARKER)).toBe(false);
      }
    }
    expect(await mongo.db.collection('pending_envelopes').countDocuments()).toBeGreaterThan(0);
    expect(mongoDocs).toBeGreaterThan(0);

    expect(frames.length).toBeGreaterThan(100);
    expect(frames.filter((frame) => containsMarker(frame, MARKER))).toEqual([]);

    // The check can see the marker: bob's decrypted copies hold it.
    await bob.start();
    await until(() => received(bob, ids) === 5, 'bob decrypts them');
    expect(bob.store.allMessages().some((m) => m.body.includes(MARKER))).toBe(true);
  });

  it('9. sends an attachment: staged ciphertext, an E2EE manifest, download and ACK', async () => {
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const plaintext = new TextEncoder().encode(`${MARKER}\n`.repeat(4_000)); // ~200 KB
    const parts: Uint8Array[] = [];
    const stream = encryptStream(crypto, pieces(plaintext));
    let encrypted: EncryptedAttachment;
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        encrypted = next.value;
        break;
      }
      parts.push(next.value);
    }
    const ciphertext = new Uint8Array(Buffer.concat(parts));

    // Staged for the devices the message goes to, then sent with the manifest.
    const recipients = await alice.engine.attachmentRecipients(conversationId);
    expect(recipients).toContain(bob.deviceId);
    expect(recipients).not.toContain(alice.deviceId);
    const attachmentId = uuidv7();
    await uploadAttachment({
      api: attachmentsApi(alice.api),
      attachmentId,
      ciphertextSize: ciphertext.length,
      ciphertextSha256: encrypted.ciphertextSha256,
      recipientDeviceIds: recipients,
      readRange: (start, end) => Promise.resolve(ciphertext.subarray(start, end)),
    });
    const manifest = buildManifest({
      attachmentId,
      encrypted,
      mimeType: 'text/plain',
      fileName: 'notes.txt',
      caption: MARKER,
    });
    const sent = await alice.engine.sendAttachment(conversationId, manifest);

    await until(
      async () => (await bob.engine.getMessage(sent.messageId))?.kind === 'attachment',
      'bob gets the manifest',
    );
    const message = (await bob.engine.getMessage(sent.messageId))!;
    expect(message).toMatchObject({ body: MARKER, attachment: { fileName: 'notes.txt' } });
    const { url } = await attachmentsApi(bob.api).downloadUrl(attachmentId);
    const staged = new Uint8Array(await (await fetch(url)).arrayBuffer());
    expect(staged).toEqual(ciphertext);
    expect(containsMarker(staged, MARKER)).toBe(false);
    const opened: Uint8Array[] = [];
    const input = attachmentDecryptInput(message.attachment!);
    for await (const piece of decryptStream(crypto, input, pieces(staged))) opened.push(piece);
    expect(new Uint8Array(Buffer.concat(opened))).toEqual(plaintext);
    await attachmentsApi(bob.api).ack(attachmentId);

    await until(
      () => allIn(alice, [sent.messageId], 'delivered_to_recipient_device'),
      'the delivery receipt',
    );
    // The caption and the key travelled only inside E2EE frames.
    expect(frames.filter((frame) => containsMarker(frame, MARKER))).toEqual([]);
  });
});

/** Bytes as a stream of 50 KB pieces, as a file would be read. */
async function* pieces(data: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += 50_000) {
    await Promise.resolve();
    yield data.subarray(i, i + 50_000);
  }
}
