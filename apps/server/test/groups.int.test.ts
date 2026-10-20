/**
 * Groups (Phase 13, ADR 0016) on the real server:
 * - REST: roles, versions, the size limit, members-only reads, owner hand-over on leave;
 * - gateway: group envelopes only between current members, `GroupChanged` notices;
 * - E2EE with sim clients (vodozemac via WASM): three members, a removed member who cannot
 *   decrypt what follows (REQ §19.1 bullet 4), a new member who cannot read the past, a
 *   member with two devices, and a Megolm message that arrives before its key.
 */
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import {
  Accepted_Status,
  bytesToUuid,
  CryptoType,
  decodeEnvelope,
  decodeServerFrame,
  uuidv7,
} from '@pingdost/protocol';
import type { AuthTokens, Group } from '@pingdost/shared-types';
import {
  capturingSocket,
  SimClient,
  type NewDeviceKeys,
  type SimClientOptions,
} from '@pingdost/sim-client';
import type { WebSocketFactory, WebSocketLike } from '@pingdost/transport';

import { cryptoProvider } from './devices';
import { bearer, json, MAILPIT_URL, startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket, type TestDeviceSession } from './ws';
import type { DeviceDoc } from '../src/modules/device/repo';

let crypto: CryptoProvider;
let server: TestServer;
let port = 0;
const clients: SimClient[] = [];
/** Every WebSocket frame a sim client sent or received. */
const frames: Uint8Array[] = [];

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    env: { GROUP_MAX_MEMBERS: '5' },
    throttles: { keyClaims: { limit: 10_000, windowMs: 3_600_000 } },
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  port = (server.app.server.address() as AddressInfo).port;
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
    settings: { directoryMaxAgeMs: 0, receiptDelayMs: 50, retry: { baseMs: 200, maxMs: 1_000 } },
    createSocket: capturingSocket(frames),
    ...overrides,
  };
}

async function sim(overrides: Partial<SimClientOptions> = {}): Promise<SimClient> {
  const client = await SimClient.register(options(overrides));
  clients.push(client);
  await client.start();
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

function texts(client: SimClient, groupId: string): string[] {
  return client.store
    .allMessages()
    .filter((m) => m.conversationId === groupId && m.kind === 'text')
    .reverse()
    .map((m) => m.body);
}

/** Megolm ciphertexts the server delivered to `deviceId`, from the captured frames. */
function megolmDeliveredTo(
  deviceId: string,
): { sender: string; session: string; ciphertext: Uint8Array }[] {
  const out: { sender: string; session: string; ciphertext: Uint8Array }[] = [];
  for (const bytes of frames) {
    let frame;
    try {
      frame = decodeServerFrame(bytes);
    } catch {
      continue; // a client frame
    }
    if (frame.body.case !== 'deliver' || !frame.body.value.packet) continue;
    const envelope = decodeEnvelope(frame.body.value.packet.payload);
    if (envelope.cryptoType !== CryptoType.MEGOLM) continue;
    if (bytesToUuid(envelope.recipientDeviceId) !== deviceId) continue;
    out.push({
      sender: bytesToUuid(envelope.senderDeviceId),
      session: envelope.megolmSessionId,
      ciphertext: envelope.ciphertext,
    });
  }
  return out;
}

/** Whether any Megolm session `client` holds decrypts `message`. */
async function canDecrypt(
  client: SimClient,
  message: { sender: string; session: string; ciphertext: Uint8Array },
): Promise<boolean> {
  const record = await client.store.getInboundGroupSession(message.sender, message.session);
  if (!record) return false;
  const session = crypto.restoreInboundGroupSession(record.pickle, client.pickleKey);
  try {
    session.decrypt(message.ciphertext);
    return true;
  } catch {
    return false;
  } finally {
    session.dispose();
  }
}

function request(
  session: { accessToken: string },
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  url: string,
  payload?: object,
) {
  return server.app.inject({
    method,
    url,
    headers: bearer(session.accessToken),
    ...(payload ? { payload } : {}),
  });
}

describe('groups REST', () => {
  let owner: TestDeviceSession;
  let admin: TestDeviceSession;
  let member: TestDeviceSession;
  let outsider: TestDeviceSession;
  let groupId: string;

  beforeAll(async () => {
    owner = await deviceSession(server, crypto);
    admin = await deviceSession(server, crypto);
    member = await deviceSession(server, crypto);
    outsider = await deviceSession(server, crypto);
    groupId = uuidv7();
  });

  it('creates a group with the caller as owner, readable by members only', async () => {
    const created = await request(owner, 'POST', '/v1/groups', {
      groupId,
      memberUserIds: [admin.userId, member.userId, owner.userId],
    });
    expect(created.statusCode).toBe(201);
    expect(json<Group>(created)).toMatchObject({
      groupId,
      createdBy: owner.userId,
      version: 1,
      members: [
        { userId: owner.userId, role: 'owner' },
        { userId: admin.userId, role: 'member' },
        { userId: member.userId, role: 'member' },
      ],
    });
    expect(
      json(await request(owner, 'POST', '/v1/groups', { groupId, memberUserIds: [admin.userId] })),
    ).toMatchObject({ code: 'CONFLICT' });
    expect(json(await request(outsider, 'GET', `/v1/groups/${groupId}`))).toMatchObject({
      code: 'NOT_A_MEMBER',
    });
    expect(
      json<{ groups: Group[] }>(await request(member, 'GET', '/v1/groups')).groups.map(
        (g) => g.groupId,
      ),
    ).toContain(groupId);
  });

  it('lets the owner set roles, admins add and remove members, never more', async () => {
    expect(
      json<Group>(
        await request(owner, 'PATCH', `/v1/groups/${groupId}/members/${admin.userId}`, {
          role: 'admin',
        }),
      ),
    ).toMatchObject({ version: 2 });
    expect(
      json(
        await request(admin, 'PATCH', `/v1/groups/${groupId}/members/${member.userId}`, {
          role: 'admin',
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      json(
        await request(member, 'POST', `/v1/groups/${groupId}/members`, {
          userIds: [outsider.userId],
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      json<Group>(
        await request(admin, 'POST', `/v1/groups/${groupId}/members`, {
          userIds: [outsider.userId],
        }),
      ).members,
    ).toHaveLength(4);
    expect(
      json(await request(admin, 'DELETE', `/v1/groups/${groupId}/members/${owner.userId}`)),
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      json<Group>(
        await request(admin, 'DELETE', `/v1/groups/${groupId}/members/${outsider.userId}`),
      ),
    ).toMatchObject({ version: 4 });
    expect(
      json(await request(owner, 'POST', `/v1/groups/${groupId}/members`, { userIds: [uuidv7()] })),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enforces GROUP_MAX_MEMBERS', async () => {
    const extra = await Promise.all(Array.from({ length: 3 }, () => deviceSession(server, crypto)));
    const full = await request(owner, 'POST', `/v1/groups/${groupId}/members`, {
      userIds: extra.map((e) => e.userId),
    });
    expect(json(full)).toMatchObject({ code: 'GROUP_FULL' });
    const tooBig = await request(owner, 'POST', '/v1/groups', {
      groupId: uuidv7(),
      memberUserIds: [...extra, admin, member].map((e) => e.userId),
    });
    expect(json(tooBig)).toMatchObject({ code: 'GROUP_FULL' });
  });

  it('hands ownership on when the owner leaves', async () => {
    const left = json<Group>(
      await request(owner, 'DELETE', `/v1/groups/${groupId}/members/${owner.userId}`),
    );
    expect(left.members).toEqual([
      expect.objectContaining({ userId: admin.userId, role: 'owner' }),
      expect.objectContaining({ userId: member.userId, role: 'member' }),
    ]);
  });

  it('accepts group envelopes only between current members, and notifies members of changes', async () => {
    const id = uuidv7();
    await request(owner, 'POST', '/v1/groups', { groupId: id, memberUserIds: [member.userId] });
    const socket = await TestSocket.connect(server, owner);
    let memberSocket: TestSocket | undefined;
    try {
      // The member is offline: the envelope is stored for them.
      const toMember = envelopePacket(server, owner.deviceId, member.deviceId, { groupId: id });
      expect(await socket.reply(socket.sendPacket(toMember.packet))).toMatchObject({
        case: 'accepted',
        value: { status: Accepted_Status.STORED },
      });
      const toOutsider = envelopePacket(server, owner.deviceId, outsider.deviceId, { groupId: id });
      expect(await socket.reply(socket.sendPacket(toOutsider.packet))).toMatchObject({
        case: 'error',
        value: { code: 'NOT_A_MEMBER' },
      });

      memberSocket = await TestSocket.connect(server, member);
      await request(owner, 'DELETE', `/v1/groups/${id}/members/${member.userId}`);
      // The removed member hears of the change, and can no longer send into the group.
      expect(await memberSocket.next('groupChanged')).toMatchObject({ version: 2n });
      const fromRemoved = envelopePacket(server, member.deviceId, owner.deviceId, { groupId: id });
      expect(await memberSocket.reply(memberSocket.sendPacket(fromRemoved.packet))).toMatchObject({
        case: 'error',
        value: { code: 'NOT_A_MEMBER' },
      });
    } finally {
      socket.close();
      memberSocket?.close();
    }
  });
});

/** Delays room keys (Olm, group-tagged) on their way in, so Megolm messages overtake them. */
function delayingRoomKeys(capture: WebSocketFactory, delayMs: number): WebSocketFactory {
  return (url) => {
    const socket = capture(url) as unknown as WebSocket;
    // The transport's handler is kept here; the socket's own message events feed it.
    let handler: ((event: { data: unknown }) => void) | null = null;
    Object.defineProperty(socket, 'onmessage', {
      configurable: true,
      get: () => handler,
      set: (next: ((event: { data: unknown }) => void) | null) => {
        handler = next;
      },
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      const deliver = handler;
      if (!deliver) return;
      const frame = decodeServerFrame(new Uint8Array(event.data as ArrayBuffer));
      const packet = frame.body.case === 'deliver' ? frame.body.value.packet : undefined;
      const envelope = packet && decodeEnvelope(packet.payload);
      if (envelope?.groupId && envelope.cryptoType !== CryptoType.MEGOLM) {
        setTimeout(() => deliver({ data: event.data }), delayMs);
      } else {
        deliver({ data: event.data });
      }
    });
    return socket as unknown as WebSocketLike;
  };
}

describe('group chats end to end', () => {
  it('three members talk; a removed member cannot decrypt what follows (REQ §19.1)', async () => {
    const [alice, bob, carol] = [await sim(), await sim(), await sim()];
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Integration',
      memberUserIds: [bob.userId, carol.userId],
    });
    await until(
      async () => (await carol.engine.getGroup(groupId)) !== undefined,
      'carol knows the group',
    );
    await alice.engine.sendText(groupId, 'hello group');
    await until(
      () => texts(bob, groupId).length === 1 && texts(carol, groupId).length === 1,
      'first message',
    );
    await bob.engine.sendText(groupId, 'bob here');
    await until(
      () => texts(alice, groupId).length === 2 && texts(carol, groupId).length === 2,
      'reply',
    );

    await alice.engine.removeGroupMember(groupId, carol.userId);
    await until(async () => (await carol.engine.getGroup(groupId))?.left === true, 'carol removed');
    await until(
      async () => (await bob.engine.getGroup(groupId))?.members.length === 2,
      'bob sees it',
    );
    const before = megolmDeliveredTo(bob.deviceId).length;
    await alice.engine.sendText(groupId, 'after removal (alice)');
    await bob.engine.sendText(groupId, 'after removal (bob)');
    await until(
      () => texts(bob, groupId).length === 4 && texts(alice, groupId).length === 4,
      'after',
    );
    expect(texts(carol, groupId)).toEqual(['hello group', 'bob here']);
    const later = [
      ...megolmDeliveredTo(bob.deviceId).slice(before),
      ...megolmDeliveredTo(alice.deviceId).slice(-1),
    ];
    expect(later.length).toBeGreaterThanOrEqual(2);
    for (const message of later) expect(await canDecrypt(carol, message)).toBe(false);
  });

  it('a new member reads only what comes after joining', async () => {
    const [alice, bob] = [await sim(), await sim()];
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Late joiner',
      memberUserIds: [bob.userId],
    });
    await alice.engine.sendText(groupId, 'before dave');
    await until(() => texts(bob, groupId).length === 1, 'bob');
    const old = megolmDeliveredTo(bob.deviceId).at(-1)!;
    const dave = await sim();
    await alice.engine.addGroupMembers(groupId, [dave.userId]);
    await until(async () => (await dave.engine.getGroup(groupId))?.name === 'Late joiner', 'dave');
    await alice.engine.sendText(groupId, 'hi dave');
    await until(() => texts(dave, groupId).length === 1, 'dave reads the new message');
    expect(texts(dave, groupId)).toEqual(['hi dave']);
    expect(await canDecrypt(dave, old)).toBe(false);
  });

  it('reaches both devices of a member; a message that beats its key waits for it', async () => {
    const alice = await sim({ createSocket: delayingRoomKeys(capturingSocket(frames), 600) });
    const bob = await sim();
    const bob2 = await SimClient.linkedDevice(options(), bob, (keys) =>
      bindLinkedDevice(bob, keys),
    );
    clients.push(bob2);
    await bob2.start();
    const carol = await sim();
    const { conversationId: groupId } = await bob.engine.createGroup({
      name: 'Two devices',
      memberUserIds: [alice.userId, carol.userId],
    });
    await until(async () => (await alice.engine.getGroup(groupId)) !== undefined, 'alice knows it');
    await until(async () => (await bob2.engine.getGroup(groupId)) !== undefined, 'bob2 knows it');
    await bob2.engine.sendText(groupId, 'from bob2');
    await until(() => texts(alice, groupId).length === 1, 'alice reads it after the late key');
    await until(() => texts(bob, groupId).length === 1, "bob's phone has the copy");
    expect(bob.store.allMessages().find((m) => m.body === 'from bob2')?.direction).toBe('out');
    await alice.engine.sendText(groupId, 'to both bobs');
    await until(
      () => texts(bob2, groupId).length === 2 && texts(bob, groupId).length === 2,
      'both',
    );
  });
});

/** A linked device for `owner`, bound out of band until QR pairing exists (Phase 16). */
async function bindLinkedDevice(owner: SimClient, keys: NewDeviceKeys): Promise<AuthTokens> {
  const login = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { identifier: owner.username, password: owner.password },
  });
  const { tokens } = json<{ tokens: AuthTokens }>(login);
  const sessions = server.mongo.db.collection<{
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
  await server.mongo.db.collection<DeviceDoc>('devices').insertOne({
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
  await server.mongo.db
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
