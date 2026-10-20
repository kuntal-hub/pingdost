/**
 * The engine end to end over the in-memory fake server, with real vodozemac (WASM) crypto:
 * states, receipts, retries, dedupe, fan-out, device changes, session repair, expiry, typing.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { deviceCertificateMessage, uuidToBytes } from '@pingdost/protocol';

import type { ConversationEvent, EngineEvent } from './core';
import type { MessageRecord } from './store';
import { createTestClient, eventually, FakeServer, type TestClient } from './testing';

let crypto: CryptoProvider;
const running: TestClient[] = [];

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const client of running.splice(0)) await client.engine.stop();
});

async function client(server: FakeServer, options: Parameters<typeof createTestClient>[2] = {}) {
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

function messagesOf(c: TestClient): Promise<MessageRecord[]> {
  return Promise.resolve(c.store.allMessages());
}

async function stateOf(c: TestClient, messageId: string) {
  return (await c.engine.getMessage(messageId))?.state;
}

async function chat(from: TestClient, to: TestClient) {
  return from.engine.openDirectConversation(to.userId);
}

describe('MessageEngine', () => {
  it('stores before sending, and says delivered only after the recipient receipt', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await alice.engine.start(); // offline: nothing can leave yet
    const conversation = await chat(alice, bob);
    const sent = await alice.engine.sendText(conversation.conversationId, 'hello bob');
    expect(sent.state).toBe('local_queued');
    expect(await stateOf(alice, sent.messageId)).toBe('local_queued');
    expect(server.accepted).toHaveLength(0);

    alice.transport.connect();
    await eventually(async () => (await stateOf(alice, sent.messageId)) === 'sent_to_server');
    await online(bob);
    await eventually(async () => (await messagesOf(bob)).length === 1, 3_000, 'bob gets it');
    const [received] = await messagesOf(bob);
    expect(received).toMatchObject({
      messageId: sent.messageId,
      body: 'hello bob',
      direction: 'in',
      conversationId: conversation.conversationId,
      senderUserId: alice.userId,
    });
    expect((await bob.engine.getConversation(conversation.conversationId))?.unreadCount).toBe(1);
    await eventually(
      async () => (await stateOf(alice, sent.messageId)) === 'delivered_to_recipient_device',
      3_000,
      'the delivery receipt',
    );
    const info = await alice.engine.messageInfo(sent.messageId);
    expect(info?.deliveries).toEqual([
      expect.objectContaining({
        deviceId: bob.deviceId,
        own: false,
        state: 'delivered_to_recipient_device',
      }),
    ]);
    expect(server.pendingFor(bob.deviceId)).toHaveLength(0);
  });

  it('stays sent_to_server when the recipient sends no receipts', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server, { receipts: () => false });
    await online(alice, bob);
    const sent = await alice.engine.sendText((await chat(alice, bob)).conversationId, 'quiet');
    await eventually(async () => (await messagesOf(bob)).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await stateOf(alice, sent.messageId)).toBe('sent_to_server');
  });

  it('keeps the outbox across a restart', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await alice.engine.start();
    const sent = await alice.engine.sendText((await chat(alice, bob)).conversationId, 'later');
    const engine = await alice.restart();
    alice.transport.connect();
    await engine.start();
    await online(bob);
    await eventually(
      async () => (await stateOf(alice, sent.messageId)) === 'delivered_to_recipient_device',
    );
    expect((await messagesOf(bob)).map((m) => m.body)).toEqual(['later']);
  });

  it('shows one message for duplicate deliveries', async () => {
    const server = new FakeServer();
    server.duplicateDeliveries = true;
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    const conversationId = (await chat(alice, bob)).conversationId;
    for (const text of ['one', 'two', 'three']) await alice.engine.sendText(conversationId, text);
    await eventually(async () => (await messagesOf(bob)).length === 3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bob.engine.idle();
    expect((await messagesOf(bob)).map((m) => m.body).sort()).toEqual(['one', 'three', 'two']);
    expect((await bob.engine.getConversation(conversationId))?.unreadCount).toBe(3);
  });

  it('retries retryable errors with backoff, and fails on the others until retried', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    const conversationId = (await chat(alice, bob)).conversationId;

    server.sendFaults.push(
      { ok: false, code: 'MAILBOX_UNAVAILABLE', retryable: true },
      { ok: false, code: 'RATE_LIMITED', retryable: true },
    );
    const retried = await alice.engine.sendText(conversationId, 'eventually');
    await eventually(async () =>
      (await alice.store.listOutbox()).some(
        (item) => item.type === 'device' && item.attempts === 1,
      ),
    );
    await eventually(
      async () => (await stateOf(alice, retried.messageId)) === 'delivered_to_recipient_device',
    );

    server.sendFaults.push({ ok: false, code: 'FORBIDDEN', retryable: false });
    const refused = await alice.engine.sendText(conversationId, 'refused');
    await eventually(async () => (await stateOf(alice, refused.messageId)) === 'failed');
    expect(await alice.store.listOutbox()).toEqual([]);
    await alice.engine.retry(refused.messageId);
    await eventually(
      async () => (await stateOf(alice, refused.messageId)) === 'delivered_to_recipient_device',
    );
    expect((await messagesOf(bob)).filter((m) => m.body === 'refused')).toHaveLength(1);
  });

  it("fans out to the peer's devices and the sender's other devices, which never count", async () => {
    const server = new FakeServer();
    const alicePhone = await client(server);
    const aliceWeb = await client(server, { sameUserAs: alicePhone });
    const bob = await client(server, { receipts: () => false });
    await online(alicePhone, aliceWeb, bob);
    const sent = await alicePhone.engine.sendText(
      (await chat(alicePhone, bob)).conversationId,
      'hi',
    );
    await eventually(async () => (await messagesOf(aliceWeb)).length === 1, 3_000, 'own copy');
    expect((await messagesOf(aliceWeb))[0]).toMatchObject({
      messageId: sent.messageId,
      direction: 'out',
      body: 'hi',
    });
    await eventually(async () => (await messagesOf(bob)).length === 1);
    const info = await alicePhone.engine.messageInfo(sent.messageId);
    expect(info?.deliveries.map((d) => [d.deviceId, d.own]).sort()).toEqual(
      [
        [aliceWeb.deviceId, true],
        [bob.deviceId, false],
      ].sort(),
    );
    // The own web copy arrived, but only a receipt from bob's device would mean delivered.
    expect(info?.message.state).toBe('sent_to_server');
  });

  it('announces each new incoming message once, for notifications', async () => {
    const server = new FakeServer();
    const alicePhone = await client(server);
    const aliceWeb = await client(server, { sameUserAs: alicePhone });
    const bob = await client(server);
    const received = (c: TestClient) => {
      const events: EngineEvent[] = [];
      c.engine.onEvent((event) => {
        if (event.type === 'received') events.push(event);
      });
      return events;
    };
    const atBob = received(bob);
    const atAliceWeb = received(aliceWeb);
    await online(alicePhone, aliceWeb, bob);
    const { conversationId } = await chat(alicePhone, bob);
    const sent = await alicePhone.engine.sendText(conversationId, 'ping');
    await eventually(async () => (await messagesOf(bob)).length === 1);
    await alicePhone.engine.editMessage(sent.messageId, 'ping!');
    await alicePhone.engine.react(sent.messageId, '👍');
    await eventually(async () => (await bob.engine.getMessage(sent.messageId))?.body === 'ping!');
    await eventually(async () => (await messagesOf(aliceWeb)).length === 1);

    expect(atBob).toHaveLength(1);
    expect(atBob[0]).toMatchObject({
      type: 'received',
      message: { messageId: sent.messageId, body: 'ping' },
    });
    // The sender's own other device files a copy, which is not news.
    expect(atAliceWeb).toEqual([]);
  });

  it("sends new messages to a peer's new device, but not old ones", async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    const conversationId = (await chat(alice, bob)).conversationId;
    await alice.engine.sendText(conversationId, 'before');
    await eventually(async () => (await messagesOf(bob)).length === 1);
    const bob2 = await client(server, { sameUserAs: bob });
    await online(bob2);
    await alice.engine.sendText(conversationId, 'after');
    await eventually(async () => (await messagesOf(bob2)).length === 1, 3_000, 'new device');
    await eventually(async () => (await messagesOf(bob)).length === 2);
    expect((await messagesOf(bob2)).map((m) => m.body)).toEqual(['after']);
  });

  it('sends nothing more to a revoked device', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    const bob2 = await client(server, { sameUserAs: bob });
    await online(alice, bob, bob2);
    const conversationId = (await chat(alice, bob)).conversationId;
    await alice.engine.sendText(conversationId, 'to both');
    await eventually(async () => (await messagesOf(bob2)).length === 1);
    server.revoke(bob2.deviceId);
    const before = server.accepted.length;
    const sent = await alice.engine.sendText(conversationId, 'to one');
    await eventually(
      async () => (await stateOf(alice, sent.messageId)) === 'delivered_to_recipient_device',
    );
    const recipients = server.accepted.slice(before).map((p) => p.dst.join(','));
    expect(recipients).not.toContain(uuidToBytes(bob2.deviceId).join(','));
    const info = await alice.engine.messageInfo(sent.messageId);
    expect(info?.deliveries.map((d) => d.deviceId)).toEqual([bob.deviceId]);
  });

  it('repairs a broken session and resends what was lost', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    const conversationId = (await chat(alice, bob)).conversationId;
    await alice.engine.sendText(conversationId, 'first');
    await eventually(async () => (await messagesOf(bob)).length === 1);
    // bob replies, so alice's session has received and her next message is a normal one
    await bob.engine.sendText(conversationId, 'reply');
    await eventually(async () => (await messagesOf(alice)).length === 2);

    // bob loses his session state (e.g. a corrupted pickle)
    await bob.engine.stop();
    const broken = (await bob.store.listSessions(alice.deviceId)).map((s) => ({
      ...s,
      pickle: 'broken',
    }));
    await bob.store.apply({ sessions: broken });
    const bobEngine = await bob.restart();
    const failures: EngineEvent[] = [];
    bobEngine.onEvent((event) => failures.push(event));
    await bobEngine.start();

    const lost = await alice.engine.sendText(conversationId, 'lost at first');
    await eventually(() => failures.length > 0, 3_000, 'the decrypt failure');
    expect(failures[0]).toMatchObject({ type: 'decrypt_failed', deviceId: alice.deviceId });
    await eventually(
      async () => (await messagesOf(bob)).some((m) => m.messageId === lost.messageId),
      5_000,
      'the resend after the reset',
    );
    await eventually(
      async () => (await stateOf(alice, lost.messageId)) === 'delivered_to_recipient_device',
    );
    // Both sides talk on the new session from now on.
    const next = await bob.engine.sendText(conversationId, 'all good');
    await eventually(async () =>
      (await messagesOf(alice)).some((m) => m.messageId === next.messageId),
    );
  });

  it('expires undelivered messages, and a late receipt still counts', async () => {
    const server = new FakeServer();
    let offset = 0;
    const now = () => Date.now() + offset;
    const alice = await client(server, {
      now,
      settings: { maxRetentionMs: 60_000, expirySweepMs: 20 },
    });
    const bob = await client(server);
    await online(alice);
    const sent = await alice.engine.sendText((await chat(alice, bob)).conversationId, 'too late?');
    await eventually(async () => (await stateOf(alice, sent.messageId)) === 'sent_to_server');
    offset = 61_000;
    await eventually(async () => (await stateOf(alice, sent.messageId)) === 'expired_undelivered');
    expect(await alice.store.listOutbox()).toEqual([]);
    await online(bob);
    await eventually(
      async () => (await stateOf(alice, sent.messageId)) === 'delivered_to_recipient_device',
    );
  });

  it('relays typing transiently, and not at all with the toggle off', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    let bobTyping = true;
    const bob = await client(server, {
      typingIndicators: () => bobTyping,
      settings: { typingTimeoutMs: 50 },
    });
    await online(alice, bob);
    const conversationId = (await chat(alice, bob)).conversationId;
    await alice.engine.sendText(conversationId, 'so bob knows alice');
    await eventually(async () => (await messagesOf(bob)).length === 1);

    const events: ConversationEvent[] = [];
    bob.engine.subscribe(conversationId, (event) => {
      if (event.type === 'typing') events.push(event);
    });
    await alice.engine.setTyping(conversationId, true);
    await eventually(() => events.length === 2, 2_000, 'typing, then its lapse');
    expect(events).toEqual([
      { type: 'typing', userId: alice.userId, active: true },
      { type: 'typing', userId: alice.userId, active: false },
    ]);
    bobTyping = false;
    await alice.engine.setTyping(conversationId, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toHaveLength(2);
  });

  it('notices a changed safety number and resets verification', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    const conversationId = (await chat(bob, alice)).conversationId;
    await bob.engine.refreshDevices(alice.userId);
    expect(await bob.engine.markVerified(alice.userId, 'not the key')).toBe(false);
    expect(await bob.engine.markVerified(alice.userId, alice.identity.publicKey())).toBe(true);
    expect((await bob.engine.contact(alice.userId)).verified).toBe(true);

    const events: EngineEvent[] = [];
    bob.engine.onEvent((event) => events.push(event));
    const identity = crypto.createSigningKey();
    const device = server.devices.get(alice.deviceId)!;
    server.users.get(alice.userId)!.accountIdentityKey = identity.publicKey();
    device.certificate = identity.sign(
      deviceCertificateMessage(alice.deviceId, {
        curve25519: device.curve25519,
        ed25519: device.ed25519,
      }),
    );
    await bob.engine.refreshDevices(alice.userId);
    expect(events).toEqual([{ type: 'identity_changed', userId: alice.userId }]);
    expect((await bob.engine.contact(alice.userId)).verified).toBe(false);
    const [notice] = await bob.engine.listMessages(conversationId);
    expect(notice).toMatchObject({ kind: 'system', body: 'safety_number_changed' });
  });

  it('never encrypts to a device the account identity key did not certify', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    // The server swaps in a device of its own under bob's account.
    const rogue = await client(server);
    const rogueDevice = server.devices.get(rogue.deviceId)!;
    rogueDevice.userId = bob.userId;
    const sent = await alice.engine.sendText(
      (await chat(alice, bob)).conversationId,
      'for bob only',
    );
    await eventually(
      async () => (await stateOf(alice, sent.messageId)) === 'delivered_to_recipient_device',
    );
    const info = await alice.engine.messageInfo(sent.messageId);
    expect(info?.deliveries.map((d) => d.deviceId)).toEqual([bob.deviceId]);
    expect(server.pendingFor(rogue.deviceId)).toHaveLength(0);
  });
});
