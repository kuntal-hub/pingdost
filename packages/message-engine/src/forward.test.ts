/**
 * Forwarding and batch deletes (Phase 39, ADR 0043): the forwarded mark travels E2EE and is set
 * only on someone else's message; a forward fans out to several chats; several messages are
 * deleted for everyone in one batch, all or nothing.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';

import { MAX_FORWARD_TARGETS } from './engine';
import { createTestClient, eventually, FakeServer, type TestClient } from './testing';

let crypto: CryptoProvider;
const running: TestClient[] = [];

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const client of running.splice(0)) await client.engine.stop();
});

async function online(server: FakeServer, count: number): Promise<TestClient[]> {
  const clients: TestClient[] = [];
  for (let i = 0; i < count; i++) {
    const created = await createTestClient(server, crypto);
    running.push(created);
    created.transport.connect();
    await created.engine.start();
    clients.push(created);
  }
  return clients;
}

const textsOf = (c: TestClient) =>
  c.store
    .allMessages()
    .filter((m) => m.kind === 'text')
    .map((m) => ({ body: m.body, forwarded: m.forwarded === true, direction: m.direction }));

describe('forwarding', () => {
  it('marks a forward of someone else’s message, not of one’s own, end to end', async () => {
    const server = new FakeServer();
    const [alice, bob, carol] = await online(server, 3);
    const ab = await alice!.engine.openDirectConversation(bob!.userId);
    await alice!.engine.sendText(ab.conversationId, 'from alice');
    await eventually(() => textsOf(bob!).some((m) => m.body === 'from alice'), 3_000);
    const fromAlice = bob!.store.allMessages().find((m) => m.body === 'from alice')!;
    const bc = await bob!.engine.openDirectConversation(carol!.userId);
    const own = await bob!.engine.sendText(bc.conversationId, 'from bob');

    const forwarded = await bob!.engine.forwardText(fromAlice.messageId, [bc.conversationId]);
    expect(forwarded[0]?.forwarded).toBe(true);
    const again = await bob!.engine.forwardText(own.messageId, [bc.conversationId]);
    expect(again[0]?.forwarded).toBeUndefined();

    await eventually(() => textsOf(carol!).length === 3, 3_000, 'carol gets all three');
    expect(
      textsOf(carol!)
        .filter((m) => m.forwarded)
        .map((m) => m.body),
    ).toEqual(['from alice']);
    expect(
      textsOf(carol!)
        .filter((m) => !m.forwarded)
        .map((m) => m.body),
    ).toEqual(['from bob', 'from bob']);
  });

  it(`fans out to up to ${MAX_FORWARD_TARGETS} chats, and refuses more`, async () => {
    const server = new FakeServer();
    const [me, ...others] = await online(server, MAX_FORWARD_TARGETS + 2);
    const chats = [];
    for (const other of others) chats.push(await me!.engine.openDirectConversation(other.userId));
    const source = await me!.engine.sendText(chats[0]!.conversationId, 'pass it on');
    const targets = chats.slice(0, MAX_FORWARD_TARGETS).map((c) => c.conversationId);
    const sent = await me!.engine.forwardText(source.messageId, targets);
    expect(sent.map((m) => m.conversationId)).toEqual(targets);
    await expect(
      me!.engine.forwardText(
        source.messageId,
        chats.map((c) => c.conversationId),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    for (const other of others.slice(1, MAX_FORWARD_TARGETS)) {
      await eventually(() => textsOf(other).some((m) => m.body === 'pass it on'), 3_000);
    }
  });
});

describe('deleting several for everyone', () => {
  it('deletes in one batch on both sides, and refuses the whole batch with a foreign message', async () => {
    const server = new FakeServer();
    const [alice, bob] = await online(server, 2);
    const chat = await alice!.engine.openDirectConversation(bob!.userId);
    const one = await alice!.engine.sendText(chat.conversationId, 'one');
    const two = await alice!.engine.sendText(chat.conversationId, 'two');
    await eventually(() => textsOf(bob!).length === 2, 3_000);
    const reply = await bob!.engine.sendText(
      (await bob!.engine.openDirectConversation(alice!.userId)).conversationId,
      'reply',
    );
    await eventually(() => alice!.store.allMessages().some((m) => m.body === 'reply'), 3_000);

    await expect(
      alice!.engine.deleteManyForEveryone([one.messageId, reply.messageId]),
    ).rejects.toMatchObject({ code: 'not_allowed' });
    expect((await alice!.engine.getMessage(one.messageId))?.kind).toBe('text');

    const deleted = await alice!.engine.deleteManyForEveryone([one.messageId, two.messageId]);
    expect(deleted.map((m) => m.kind)).toEqual(['deleted', 'deleted']);
    await eventually(
      () =>
        bob!.store
          .allMessages()
          .filter((m) => m.direction === 'in')
          .every((m) => m.kind === 'deleted'),
      3_000,
      'both deleted on bob’s side',
    );
  });
});
