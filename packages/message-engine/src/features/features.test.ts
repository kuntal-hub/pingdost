/**
 * Phase 11 chat features end to end over the fake server, with real vodozemac (WASM):
 * reactions, replies, edits, deletes, read and delivery receipts, blocks, conversation
 * controls and search. Ops are also delivered out of order and before their target.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { bytesToUuid, envelopeIdFor } from '@pingdost/protocol';

import { MessageActionError } from '../engine';
import type { MessageRecord } from '../store';
import {
  createTestClient,
  eventually,
  FakeServer,
  type TestClient,
  type TestClientOptions,
} from '../testing';

let crypto: CryptoProvider;
const running: TestClient[] = [];

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const client of running.splice(0)) await client.engine.stop();
});

async function client(server: FakeServer, options: TestClientOptions = {}) {
  const created = await createTestClient(server, crypto, options);
  running.push(created);
  return created;
}

async function online(...clients: TestClient[]): Promise<void> {
  for (const c of clients) {
    c.transport.connect();
    await c.engine.start();
  }
}

/** A clock each test moves by hand. */
function clock(start = Date.now()) {
  const state = { t: start };
  return { now: () => state.t, state };
}

async function find(c: TestClient, messageId: string): Promise<MessageRecord | undefined> {
  return c.engine.getMessage(messageId);
}

/** Waits until `c` holds `messageId` and `check` passes on it. */
async function until(
  c: TestClient,
  messageId: string,
  check: (message: MessageRecord) => boolean,
  what: string,
): Promise<MessageRecord> {
  await eventually(
    async () => {
      const message = await find(c, messageId);
      return message !== undefined && check(message);
    },
    3_000,
    what,
  );
  return (await find(c, messageId))!;
}

/** Waits until the outbox of every client is empty (everything reached the server). */
async function drained(...clients: TestClient[]): Promise<void> {
  await eventually(
    async () => {
      for (const c of clients) {
        if ((await c.store.listOutbox()).length > 0) return false;
      }
      return true;
    },
    3_000,
    'outboxes drained',
  );
}

/** Lets packets in flight land, then waits for `c` to handle them. */
async function settle(c: TestClient): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await c.engine.idle();
}

/** Reverses the order `device` will fetch its mailbox in. */
function reverseMailbox(server: FakeServer, deviceId: string): void {
  const box = server.mailbox.get(deviceId);
  if (!box) return;
  const entries = [...box].reverse();
  box.clear();
  for (const [id, packet] of entries) box.set(id, packet);
}

function dropFromMailbox(server: FakeServer, deviceId: string, messageId: string): void {
  server.mailbox.get(deviceId)?.delete(bytesToUuid(envelopeIdFor(messageId, deviceId)));
}

describe('reactions', () => {
  it('syncs one reaction per user to the peer and to the reactor’s other devices', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    const bob2 = await client(server, { sameUserAs: bob });
    await online(alice, bob, bob2);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'lunch?');
    await until(bob, sent.messageId, () => true, 'bob gets the message');

    await bob.engine.react(sent.messageId, '👍');
    await until(
      alice,
      sent.messageId,
      (m) => m.reactions.some((r) => r.userId === bob.userId && r.emoji === '👍'),
      'alice sees the like',
    );
    await until(bob2, sent.messageId, (m) => m.reactions.length === 1, 'bob2 sees it');

    await bob2.engine.react(sent.messageId, '❤️'); // replaces bob's reaction
    await alice.engine.react(sent.messageId, '❤️');
    for (const c of [alice, bob, bob2]) {
      await until(
        c,
        sent.messageId,
        (m) =>
          m.reactions.filter((r) => r.emoji === '❤️').length === 2 &&
          !m.reactions.some((r) => r.emoji === '👍'),
        'two hearts everywhere',
      );
    }

    await bob.engine.react(sent.messageId, null);
    await until(
      alice,
      sent.messageId,
      (m) => m.reactions.find((r) => r.userId === bob.userId)?.emoji === null,
      'bob withdrew',
    );
    await expect(bob.engine.react(sent.messageId, 'not one')).rejects.toBeInstanceOf(
      MessageActionError,
    );
  });

  it('applies reactions that overtook their message in the order they were made', async () => {
    const server = new FakeServer();
    const time = clock();
    const alice = await client(server, { now: time.now });
    const bob = await client(server);
    await online(alice);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'vote');
    time.state.t += 1_000;
    await alice.engine.react(sent.messageId, '👍');
    time.state.t += 1_000;
    await alice.engine.react(sent.messageId, null);
    await drained(alice);
    // Bob fetches: the withdrawal first, then the like, then the message itself.
    reverseMailbox(server, bob.deviceId);
    await online(bob);
    const seen = await until(bob, sent.messageId, () => true, 'bob gets the message');
    await bob.engine.idle();
    const final = (await find(bob, sent.messageId))!;
    expect(seen.body).toBe('vote');
    expect(final.reactions).toEqual([
      expect.objectContaining({ userId: alice.userId, emoji: null }),
    ]);
    expect(await bob.store.listOps(sent.messageId)).toEqual([]);
  });
});

describe('replies', () => {
  it('quotes a message of the same conversation only', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    const carol = await client(server);
    await online(alice, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const other = await alice.engine.openDirectConversation(carol.userId);
    const first = await alice.engine.sendText(conversationId, 'the plan');
    const elsewhere = await alice.engine.sendText(other.conversationId, 'secret');
    const reply = await alice.engine.sendText(conversationId, 'about that', {
      replyTo: first.messageId,
    });
    const stray = await alice.engine.sendText(conversationId, 'hm', {
      replyTo: elsewhere.messageId,
    });
    expect(reply.replyTo).toBe(first.messageId);
    expect(stray.replyTo).toBeNull();
    const received = await until(bob, reply.messageId, () => true, 'bob gets the reply');
    expect(received.replyTo).toBe(first.messageId);
    // A chat the peer started previews its newest message (not only the first one).
    await until(bob, stray.messageId, () => true, 'bob gets the last one');
    expect((await bob.engine.getConversation(conversationId))?.lastMessageId).toBe(stray.messageId);
  });
});

describe('edits', () => {
  it('replaces the text everywhere with an edited mark, inside the window only', async () => {
    const server = new FakeServer();
    const time = clock();
    const alice = await client(server, { now: time.now });
    const alice2 = await client(server, { sameUserAs: alice });
    const bob = await client(server);
    await online(alice, alice2, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'meet at 5');
    await until(bob, sent.messageId, () => true, 'bob gets it');
    await until(alice2, sent.messageId, () => true, 'alice2 gets it');

    time.state.t += 60_000;
    const edited = await alice.engine.editMessage(sent.messageId, 'meet at 6');
    expect(edited).toMatchObject({ body: 'meet at 6', editedAt: time.state.t });
    for (const c of [bob, alice2]) {
      await until(c, sent.messageId, (m) => m.body === 'meet at 6' && m.editedAt !== null, 'edit');
    }
    expect(await bob.engine.search('5')).toEqual([]);
    expect((await bob.engine.search('6')).map((m) => m.messageId)).toEqual([sent.messageId]);

    // Only the sender may edit, and only inside the window.
    await expect(bob.engine.editMessage(sent.messageId, 'hacked')).rejects.toMatchObject({
      code: 'not_allowed',
    });
    time.state.t += 25 * 3_600_000;
    expect(alice.engine.canEdit((await find(alice, sent.messageId))!)).toBe(false);
    await expect(alice.engine.editMessage(sent.messageId, 'too late')).rejects.toMatchObject({
      code: 'not_allowed',
    });
  });

  it('converges on the newest of two conflicting edits from two devices', async () => {
    const server = new FakeServer();
    const base = Date.now();
    const phone = clock(base);
    const web = clock(base);
    const alice = await client(server, { now: phone.now });
    const alice2 = await client(server, { sameUserAs: alice, now: web.now });
    const bob = await client(server);
    await online(alice, alice2);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'draft');
    await until(alice2, sent.messageId, () => true, 'alice2 has the copy');

    // The web edit is newer but goes out first; the phone, offline meanwhile, edits too.
    alice.transport.disconnect();
    web.state.t = base + 2_000;
    await alice2.engine.editMessage(sent.messageId, 'final');
    phone.state.t = base + 1_000;
    await alice.engine.editMessage(sent.messageId, 'older');
    alice.transport.connect();
    await drained(alice, alice2);
    await online(bob);
    for (const c of [alice, alice2, bob]) {
      await until(c, sent.messageId, (m) => m.body === 'final', 'everyone shows the newest');
    }
    await bob.engine.idle();
    expect((await find(bob, sent.messageId))?.editedAt).toBe(base + 2_000);
  });

  it('applies an edit that arrives before its message', async () => {
    const server = new FakeServer();
    const time = clock();
    const alice = await client(server, { now: time.now });
    const bob = await client(server);
    await online(alice);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'typo');
    time.state.t += 1_000;
    await alice.engine.editMessage(sent.messageId, 'fixed');
    await drained(alice);
    reverseMailbox(server, bob.deviceId);
    await online(bob);
    const received = await until(bob, sent.messageId, () => true, 'bob gets it');
    expect(received).toMatchObject({ body: 'fixed', editedAt: time.state.t });
    expect(await bob.store.listOps(sent.messageId)).toEqual([]);
  });
});

describe('delete', () => {
  it('deletes for everyone as a tombstone; delete for me stays local', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const alice2 = await client(server, { sameUserAs: alice });
    const bob = await client(server);
    await online(alice, alice2, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const keep = await alice.engine.sendText(conversationId, 'keep me');
    const oops = await alice.engine.sendText(conversationId, 'wrong chat, sorry');
    await until(bob, oops.messageId, () => true, 'bob gets it');
    await bob.engine.react(oops.messageId, '😂');
    await until(alice, oops.messageId, (m) => m.reactions.length === 1, 'the reaction');

    await expect(bob.engine.deleteForEveryone(oops.messageId)).rejects.toMatchObject({
      code: 'not_allowed',
    });
    const tombstone = await alice.engine.deleteForEveryone(oops.messageId);
    expect(tombstone).toMatchObject({ kind: 'deleted', body: '', reactions: [] });
    for (const c of [bob, alice2]) {
      await until(c, oops.messageId, (m) => m.kind === 'deleted' && m.body === '', 'tombstone');
    }
    expect(await bob.engine.search('sorry')).toEqual([]);
    await expect(alice.engine.editMessage(oops.messageId, 'back')).rejects.toMatchObject({
      code: 'not_allowed',
    });

    // Delete for me: gone here only.
    await bob.engine.deleteForMe([keep.messageId]);
    expect(await find(bob, keep.messageId)).toBeUndefined();
    expect(await find(alice, keep.messageId)).toBeDefined();
    expect((await bob.engine.getConversation(conversationId))?.lastMessageId).toBe(oops.messageId);
  });

  it('stores a message deleted before it arrived as a tombstone, never as text', async () => {
    const server = new FakeServer();
    const time = clock();
    const alice = await client(server, { now: time.now });
    const bob = await client(server);
    await online(alice);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'never mind');
    await drained(alice);
    time.state.t += 1_000;
    await alice.engine.deleteForEveryone(sent.messageId);
    await drained(alice);
    reverseMailbox(server, bob.deviceId);
    await online(bob);
    const received = await until(bob, sent.messageId, () => true, 'bob files it');
    expect(received).toMatchObject({ kind: 'deleted', body: '' });
    expect(received.readAt).not.toBeNull();
    expect((await bob.engine.getConversation(conversationId))?.unreadCount).toBe(0);
  });

  it('keeps a tombstone for a message that never arrives, until it is pruned', async () => {
    const server = new FakeServer();
    const aliceTime = clock();
    const bobTime = clock();
    const alice = await client(server, { now: aliceTime.now });
    const bob = await client(server, { now: bobTime.now });
    await online(alice);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'lost');
    await drained(alice);
    aliceTime.state.t += 1_000;
    await alice.engine.deleteForEveryone(sent.messageId);
    await drained(alice);
    dropFromMailbox(server, bob.deviceId, sent.messageId);
    await online(bob);
    await eventually(async () => (await bob.store.listOps(sent.messageId)).length === 1);
    expect(await find(bob, sent.messageId)).toBeUndefined();

    // Past the longest an envelope can wait, the pending delete is pruned at the next sweep.
    bobTime.state.t += 16 * 86_400_000;
    await bob.restart();
    await bob.engine.start();
    expect(await bob.store.listOps(sent.messageId)).toEqual([]);
  });
});

describe('receipts', () => {
  it('sends read receipts on reading when both have them on', async () => {
    const server = new FakeServer();
    const alice = await client(server, { receipts: () => true });
    const bob = await client(server, { receipts: () => true });
    await online(alice, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'read me');
    await until(alice, sent.messageId, (m) => m.state === 'delivered_to_recipient_device', 'dlv');
    expect((await bob.store.listUnread(conversationId)).map((m) => m.messageId)).toEqual([
      sent.messageId,
    ]);
    await bob.engine.markRead(conversationId);
    await until(alice, sent.messageId, (m) => m.state === 'read', 'read');
    expect(await bob.store.listUnread(conversationId)).toEqual([]);
    expect((await bob.engine.getConversation(conversationId))?.unreadCount).toBe(0);
  });

  it('with read receipts off, sends none and shows none (reciprocal)', async () => {
    const server = new FakeServer();
    const reader = { read: false };
    const alice = await client(server, { receipts: () => true });
    const bob = await client(server, {
      receipts: (type) => (type === 'read' ? reader.read : true),
    });
    await online(alice, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'quiet');
    await until(alice, sent.messageId, (m) => m.state === 'delivered_to_recipient_device', 'dlv');
    await bob.engine.markRead(conversationId);
    await drained(bob);
    await settle(alice);
    expect((await find(alice, sent.messageId))?.state).toBe('delivered_to_recipient_device');

    // Bob's own messages: alice reads them, but bob does not see "read".
    const back = await bob.engine.sendText(conversationId, 'hi');
    await until(alice, back.messageId, () => true, 'alice gets it');
    await alice.engine.markRead(conversationId);
    await drained(alice);
    await settle(bob);
    await until(bob, back.messageId, (m) => m.state === 'delivered_to_recipient_device', 'dlv');
    await settle(bob);
    expect((await find(bob, back.messageId))?.state).toBe('delivered_to_recipient_device');
  });

  it('with delivery receipts off, the sender sees only "sent"', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server, { receipts: () => false });
    await online(alice, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const sent = await alice.engine.sendText(conversationId, 'shh');
    await until(bob, sent.messageId, () => true, 'bob gets it');
    await settle(bob);
    expect(await bob.store.listOutbox()).toEqual([]);
    await settle(alice);
    expect((await find(alice, sent.messageId))?.state).toBe('sent_to_server');
  });
});

describe('blocking', () => {
  it('drops what a blocked user still sends, without a receipt', async () => {
    const server = new FakeServer();
    const blocked = new Set<string>();
    const alice = await client(server);
    const bob = await client(server, { blocked: (userId) => blocked.has(userId) });
    await online(alice, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const before = await alice.engine.sendText(conversationId, 'hi');
    await until(bob, before.messageId, () => true, 'bob gets it');
    blocked.add(alice.userId);
    const after = await alice.engine.sendText(conversationId, 'are you there?');
    await eventually(async () => (await bob.store.hasSeen(after.messageId)) === true);
    expect(await find(bob, after.messageId)).toBeUndefined();
    await settle(bob);
    await settle(alice);
    expect((await find(alice, after.messageId))?.state).toBe('sent_to_server');
  });
});

describe('conversations', () => {
  it('archives, pins, mutes and deletes locally; a new message starts afresh', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    await alice.engine.sendText(conversationId, 'reaches the mailbox');
    await drained(alice);
    // Offline: this one stays in the outbox.
    alice.transport.disconnect();
    const pending = await alice.engine.sendText(conversationId, 'not sent');
    await alice.engine.setArchived(conversationId, true);
    await alice.engine.setPinned(conversationId, true);
    await alice.engine.setMuted(conversationId, 123);
    expect(await alice.engine.getConversation(conversationId)).toMatchObject({
      archived: true,
      pinnedAt: expect.any(Number) as number,
      mutedUntil: 123,
    });

    await alice.engine.deleteConversation(conversationId);
    expect(await alice.engine.getConversation(conversationId)).toBeUndefined();
    expect(await find(alice, pending.messageId)).toBeUndefined();
    expect(
      (await alice.store.listOutbox()).filter((item) => item.messageId === pending.messageId),
    ).toEqual([]);

    await online(bob);
    alice.transport.connect();
    const again = await bob.engine.openDirectConversation(alice.userId);
    const fresh = await bob.engine.sendText(again.conversationId, 'hello again');
    await until(alice, fresh.messageId, () => true, 'alice gets it');
    expect(await alice.engine.getConversation(conversationId)).toMatchObject({
      archived: false,
      pinnedAt: null,
      unreadCount: 1,
    });
    expect(await find(alice, pending.messageId)).toBeUndefined();
  });

  it('searches one conversation or all of them', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    const carol = await client(server);
    await online(alice);
    const withBob = await alice.engine.openDirectConversation(bob.userId);
    const withCarol = await alice.engine.openDirectConversation(carol.userId);
    const a = await alice.engine.sendText(withBob.conversationId, 'Pizza tonight?');
    const b = await alice.engine.sendText(withCarol.conversationId, 'pizzeria list');
    expect((await alice.engine.search('pizz')).map((m) => m.messageId)).toEqual([
      b.messageId,
      a.messageId,
    ]);
    expect(
      (await alice.engine.search('PIZZA', { conversationId: withBob.conversationId })).map(
        (m) => m.messageId,
      ),
    ).toEqual([a.messageId]);
  });
});
