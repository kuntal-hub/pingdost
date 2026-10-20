/**
 * Group chats end to end over the in-memory fake server with real vodozemac (ADR 0016):
 * Megolm fan-out, room keys over Olm, rotation, removal, late joiners, multi-device, keys
 * that arrive after their message, replays, controls and info.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import {
  bytesToUuid,
  create,
  CryptoType,
  decodeEnvelope,
  decodeTransportPacket,
  encodeEnvelope,
  encodeTransportPacket,
  EnvelopeSchema,
  uuidToBytes,
  uuidv7,
  type TransportPacket,
} from '@pingdost/protocol';

import { parseGroupNotice } from './notices';
import type { MessageRecord } from '../store';
import { createTestClient, eventually, FakeServer, type TestClient } from '../testing';

let crypto: CryptoProvider;
const running: TestClient[] = [];

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const client of running.splice(0)) await client.engine.stop();
});

async function client(
  server: FakeServer,
  options: Parameters<typeof createTestClient>[2] = {},
): Promise<TestClient> {
  const created = await createTestClient(server, crypto, { oneTimeKeys: 20, ...options });
  running.push(created);
  return created;
}

async function online(...clients: TestClient[]): Promise<void> {
  for (const c of clients) {
    c.transport.connect();
    await c.engine.start();
  }
}

function texts(c: TestClient, groupId: string): string[] {
  return c.store
    .allMessages()
    .filter((m) => m.conversationId === groupId && m.kind === 'text')
    .reverse()
    .map((m) => m.body);
}

function notices(c: TestClient, groupId: string): string[] {
  return c.store
    .allMessages()
    .filter((m: MessageRecord) => m.conversationId === groupId && m.kind === 'system')
    .reverse()
    .map((m) => parseGroupNotice(m.body)?.type ?? m.body);
}

/** Megolm packets the server accepted for `deviceId`. */
function megolmTo(server: FakeServer, deviceId: string): TransportPacket[] {
  return server.accepted.filter((packet) => {
    const envelope = decodeEnvelope(packet.payload);
    return (
      envelope.cryptoType === CryptoType.MEGOLM &&
      bytesToUuid(envelope.recipientDeviceId) === deviceId
    );
  });
}

/** Tries every Megolm session `c` holds on `packet`'s ciphertext. */
async function canDecrypt(c: TestClient, packet: TransportPacket): Promise<boolean> {
  const envelope = decodeEnvelope(packet.payload);
  const sender = bytesToUuid(envelope.senderDeviceId);
  const record = await c.store.getInboundGroupSession(sender, envelope.megolmSessionId);
  if (!record) return false;
  const session = crypto.restoreInboundGroupSession(record.pickle, c.pickleKey);
  try {
    session.decrypt(envelope.ciphertext);
    return true;
  } catch {
    return false;
  } finally {
    session.dispose();
  }
}

async function threeMembers(server: FakeServer) {
  const alice = await client(server);
  const bob = await client(server);
  const carol = await client(server);
  await online(alice, bob, carol);
  const { conversationId: groupId } = await alice.engine.createGroup({
    name: 'Trip',
    memberUserIds: [bob.userId, carol.userId],
  });
  await eventually(async () => (await bob.engine.getGroup(groupId)) !== undefined, 3_000, 'bob');
  await eventually(
    async () => (await carol.engine.getGroup(groupId)) !== undefined,
    3_000,
    'carol',
  );
  return { alice, bob, carol, groupId };
}

describe('group chats', () => {
  it('three members exchange messages; delivered once every member has it', async () => {
    const server = new FakeServer();
    const { alice, bob, carol, groupId } = await threeMembers(server);
    expect(await bob.engine.getGroup(groupId)).toMatchObject({ name: 'Trip', version: 1 });
    expect(notices(bob, groupId)).toEqual(['created']);

    const sent = await alice.engine.sendText(groupId, 'hello all');
    await eventually(() => texts(bob, groupId).length === 1 && texts(carol, groupId).length === 1);
    await bob.engine.sendText(groupId, 'hi from bob');
    await eventually(
      () => texts(alice, groupId).length === 2 && texts(carol, groupId).length === 2,
    );
    expect(texts(carol, groupId)).toEqual(['hello all', 'hi from bob']);
    await eventually(
      async () =>
        (await alice.engine.getMessage(sent.messageId))?.state === 'delivered_to_recipient_device',
      3_000,
      'delivered to both',
    );
    // One Megolm encryption: every member device got the same ciphertext.
    const [toBob] = megolmTo(server, bob.deviceId);
    const [toCarol] = megolmTo(server, carol.deviceId);
    expect(decodeEnvelope(toBob!.payload).ciphertext).toEqual(
      decodeEnvelope(toCarol!.payload).ciphertext,
    );
  });

  it('a removed member cannot decrypt anything sent after the removal (REQ §19.1)', async () => {
    const server = new FakeServer();
    const { alice, bob, carol, groupId } = await threeMembers(server);
    await alice.engine.sendText(groupId, 'before');
    await eventually(() => texts(carol, groupId).length === 1);

    await alice.engine.removeGroupMember(groupId, carol.userId);
    await eventually(
      async () => (await carol.engine.getGroup(groupId))?.left === true,
      3_000,
      'left',
    );
    await eventually(async () => (await bob.engine.getGroup(groupId))?.members.length === 2);
    expect(notices(bob, groupId)).toContain('removed');

    await alice.engine.sendText(groupId, 'after, from alice');
    await bob.engine.sendText(groupId, 'after, from bob');
    await eventually(() => texts(bob, groupId).length === 3 && texts(alice, groupId).length === 3);
    expect(texts(carol, groupId)).toEqual(['before']);
    // The server never routed the new messages to carol, and even with their ciphertext
    // (taken from bob's mailbox) her keys cannot open them: both senders rotated.
    expect(megolmTo(server, carol.deviceId)).toHaveLength(1);
    const later = [...megolmTo(server, bob.deviceId), ...megolmTo(server, alice.deviceId)].slice(
      -2,
    );
    for (const packet of later) expect(await canDecrypt(carol, packet)).toBe(false);
    await expect(carol.engine.sendText(groupId, 'still here?')).rejects.toMatchObject({
      code: 'not_allowed',
    });
  });

  it('a new member cannot decrypt messages from before they joined', async () => {
    const server = new FakeServer();
    const { alice, bob, groupId } = await threeMembers(server);
    await alice.engine.sendText(groupId, 'old news');
    await eventually(() => texts(bob, groupId).length === 1);
    const old = megolmTo(server, bob.deviceId)[0]!;

    const dave = await client(server);
    await online(dave);
    await alice.engine.addGroupMembers(groupId, [dave.userId]);
    await eventually(
      async () => (await dave.engine.getGroup(groupId)) !== undefined,
      3_000,
      'dave',
    );
    expect(await dave.engine.getGroup(groupId)).toMatchObject({ name: 'Trip' });
    expect(notices(dave, groupId)).toEqual(['joined']);
    await eventually(async () => (await bob.engine.getGroup(groupId))?.members.length === 4);

    await alice.engine.sendText(groupId, 'welcome dave');
    await eventually(() => texts(dave, groupId).length === 1);
    expect(texts(dave, groupId)).toEqual(['welcome dave']);
    expect(await canDecrypt(dave, old)).toBe(false);
  });

  it('reaches every device of a member, and files own copies', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bobPhone = await client(server);
    const bobWeb = await client(server, { sameUserAs: bobPhone });
    const carol = await client(server);
    await online(alice, bobPhone, bobWeb, carol);
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Devices',
      memberUserIds: [bobPhone.userId, carol.userId],
    });
    await alice.engine.sendText(groupId, 'to both of bob');
    await eventually(
      () => texts(bobPhone, groupId).length === 1 && texts(bobWeb, groupId).length === 1,
    );
    await bobPhone.engine.sendText(groupId, 'from the phone');
    await eventually(
      () => texts(bobWeb, groupId).length === 2 && texts(alice, groupId).length === 2,
    );
    const copy = bobWeb.store.allMessages().find((m) => m.body === 'from the phone');
    expect(copy?.direction).toBe('out');
  });

  it('holds a message whose key arrives later, then shows it', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    const carol = await client(server);
    await online(alice, bob, carol);
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Order',
      memberUserIds: [bob.userId, carol.userId],
    });
    await eventually(async () => (await bob.engine.getGroup(groupId)) !== undefined);
    bob.transport.disconnect();
    await alice.engine.sendText(groupId, 'key comes second');
    await eventually(() => server.pendingFor(bob.deviceId).length === 2, 3_000, 'both queued');
    // Reorder bob's mailbox: the Megolm message first, its room key after it.
    const box = server.mailbox.get(bob.deviceId)!;
    const entries = [...box.entries()].sort(([, a]) =>
      decodeEnvelope(a.payload).cryptoType === CryptoType.MEGOLM ? -1 : 1,
    );
    box.clear();
    for (const [id, packet] of entries) box.set(id, packet);
    expect(decodeEnvelope(server.pendingFor(bob.deviceId)[0]!.payload).cryptoType).toBe(
      CryptoType.MEGOLM,
    );
    bob.transport.connect();
    await eventually(() => texts(bob, groupId).length === 1, 3_000, 'held message shown');
    expect(await bob.store.listHeld(groupId)).toEqual([]);
  });

  it('rejects a replayed Megolm message under a new envelope ID', async () => {
    const server = new FakeServer();
    const logs: string[] = [];
    const alice = await client(server);
    const bob = await client(server, { log: (_level, message) => logs.push(message) });
    const carol = await client(server);
    await online(alice, bob, carol);
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Replay',
      memberUserIds: [bob.userId, carol.userId],
    });
    await alice.engine.sendText(groupId, 'once');
    await eventually(() => texts(bob, groupId).length === 1);
    const original = megolmTo(server, bob.deviceId)[0]!;
    const envelope = decodeEnvelope(original.payload);
    const replay = encodeTransportPacket({
      ...original,
      packetId: uuidToBytes(uuidv7()),
      payload: encodeEnvelope(
        create(EnvelopeSchema, { ...envelope, envelopeId: uuidToBytes(uuidv7()) }),
      ),
    });
    bob.transport.deliver(decodeTransportPacket(replay));
    await eventually(() => logs.includes('replayed group message dropped'), 3_000, 'replay log');
    expect(texts(bob, groupId)).toEqual(['once']);
  });

  it('lets members leave, admins rename, and the owner promote', async () => {
    const server = new FakeServer();
    const { alice, bob, carol, groupId } = await threeMembers(server);
    await alice.engine.setGroupRole(groupId, bob.userId, 'admin');
    await eventually(
      async () =>
        (await carol.engine.getGroup(groupId))?.members.some(
          (m) => m.userId === bob.userId && m.role === 'admin',
        ) ?? false,
    );
    await bob.engine.updateGroupInfo(groupId, { name: 'Renamed', description: 'by bob' });
    await eventually(async () => (await carol.engine.getGroup(groupId))?.name === 'Renamed');
    await expect(carol.engine.updateGroupInfo(groupId, { name: 'Nope' })).rejects.toMatchObject({
      code: 'not_allowed',
    });

    await carol.engine.leaveGroup(groupId);
    await eventually(async () => (await alice.engine.getGroup(groupId))?.members.length === 2);
    expect(notices(alice, groupId)).toEqual(['created', 'role', 'info', 'left']);
    expect((await carol.engine.getGroup(groupId))?.left).toBe(true);
    await carol.engine.deleteConversation(groupId);
    expect(await carol.engine.getGroup(groupId)).toBeUndefined();
    await expect(alice.engine.deleteConversation(groupId)).rejects.toMatchObject({
      code: 'not_allowed',
    });
  });

  it('rotates the Megolm session after the configured number of messages', async () => {
    const server = new FakeServer();
    const alice = await client(server, { settings: { groupRotationMessages: 2 } });
    const bob = await client(server);
    await online(alice, bob);
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Busy',
      memberUserIds: [bob.userId],
    });
    for (const text of ['one', 'two', 'three']) await alice.engine.sendText(groupId, text);
    await eventually(() => texts(bob, groupId).length === 3);
    const sessions = new Set(
      megolmTo(server, bob.deviceId).map((p) => decodeEnvelope(p.payload).megolmSessionId),
    );
    expect(sessions.size).toBe(2);
  });

  it('enforces roles and the size limit', async () => {
    const server = new FakeServer();
    server.groupMaxMembers = 3;
    const { alice, bob, groupId } = await threeMembers(server);
    const dave = await client(server);
    await expect(bob.engine.addGroupMembers(groupId, [dave.userId])).rejects.toMatchObject({
      code: 'not_allowed',
    });
    await expect(alice.engine.addGroupMembers(groupId, [dave.userId])).rejects.toMatchObject({
      code: 'GROUP_FULL',
    });
  });
});
