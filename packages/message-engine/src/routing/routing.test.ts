/**
 * Direct nearby messaging end to end (ADR 0024): two engines with real vodozemac, the fake
 * server as the Internet and an in-memory radio as Bluetooth, through the real router and
 * nearby transport. Offline = the socket down and every REST call failing.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { nearbyHelloMessage } from '@pingdost/protocol';
import { NearbyPeerTransport, TransportRouter } from '@pingdost/transport';
import { connectFakeLinks, FakeLinks } from '@pingdost/transport/testing';

import { MemoryEngineStore } from '../memoryStore';
import { createTestClient, eventually, FakeServer, type TestClient } from '../testing';
import { createNearbyIdentity } from './identity';

let crypto: CryptoProvider;
const running: { client: TestClient; nearby: NearbyPeerTransport }[] = [];

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const { client, nearby } of running.splice(0)) {
    nearby.dispose();
    await client.engine.stop();
  }
});

interface Phone {
  client: TestClient;
  nearby: NearbyPeerTransport;
  radio: FakeLinks;
}

async function phone(server: FakeServer, options: { blocked?: (userId: string) => boolean } = {}) {
  const radio = new FakeLinks();
  let nearby: NearbyPeerTransport | undefined;
  const client = await createTestClient(server, crypto, {
    ...options,
    ...(process.env.ENGINE_LOG
      ? { log: (level, message, fields) => console.log(level, message, fields ?? '') }
      : {}),
    transport: ({ internet, userId, deviceId, account, store }) => {
      nearby = new NearbyPeerTransport({
        links: radio,
        identity: createNearbyIdentity({
          self: { userId, deviceId },
          crypto,
          account,
          store,
          ...(options.blocked ? { blocked: options.blocked } : {}),
        }),
        ackTimeoutMs: 300,
        handshakeTimeoutMs: 1_000,
      });
      return new TransportRouter([internet, nearby]);
    },
  });
  if (!nearby) throw new Error('no nearby transport');
  running.push({ client, nearby });
  return { client, nearby, radio } satisfies Phone;
}

/** Both online once: each caches the other's verified directory (with its fallback key). */
async function introduce(server: FakeServer, ...phones: Phone[]) {
  for (const p of phones) {
    p.client.transport.connect();
    await p.client.engine.start();
  }
  for (const p of phones) {
    for (const other of phones) {
      if (other !== p) await p.client.engine.refreshDevices(other.client.userId);
    }
  }
  void server;
}

/** Airplane mode with Bluetooth on: no socket, no REST, nearby looking for peers. */
async function airplane(server: FakeServer, ...phones: Phone[]) {
  server.apiDown = true;
  for (const p of phones) {
    p.client.transport.disconnect();
    await p.nearby.start();
  }
}

function inRange(a: Phone, b: Phone) {
  return connectFakeLinks(a.radio, b.radio);
}

async function send(from: Phone, to: Phone, text: string) {
  const conversation = await from.client.engine.openDirectConversation(to.client.userId);
  return from.client.engine.sendText(conversation.conversationId, text);
}

const stateOf = async (p: Phone, messageId: string) =>
  (await p.client.engine.getMessage(messageId))?.state;
const textsOf = (p: Phone) =>
  p.client.store
    .allMessages()
    .filter((m) => m.kind === 'text')
    .map((m) => m.body);

describe('direct nearby messaging', () => {
  it('exchanges text both ways in airplane mode, with honest states, starting a session offline', async () => {
    const server = new FakeServer();
    const alice = await phone(server);
    const bob = await phone(server);
    // They have never talked: no Olm session, only each other's cached directory.
    await introduce(server, alice, bob);
    await airplane(server, alice, bob);
    const acceptedBefore = server.accepted.length;
    inRange(alice, bob);
    await eventually(() => alice.nearby.reaches(bob.client.deviceId), 3_000, 'handshake');

    const hello = await send(alice, bob, 'hi over bluetooth');
    await eventually(() => textsOf(bob).includes('hi over bluetooth'), 5_000, 'bob gets it');
    await eventually(
      async () => (await stateOf(alice, hello.messageId)) === 'delivered_to_recipient_device',
      5_000,
      'the E2EE receipt comes back over the same link',
    );
    const info = await alice.client.engine.messageInfo(hello.messageId);
    expect(info?.deliveries).toEqual([
      expect.objectContaining({ deviceId: bob.client.deviceId, via: 'nearby' }),
    ]);

    const reply = await send(bob, alice, 'hi back');
    await eventually(() => textsOf(alice).includes('hi back'), 5_000, 'alice gets the reply');
    await eventually(
      async () => (await stateOf(bob, reply.messageId)) === 'delivered_to_recipient_device',
      5_000,
    );
    // Nothing went through the server.
    expect(server.accepted.length).toBe(acceptedBefore);
  });

  it('waits for a nearby route, then flushes when the contact comes into range', async () => {
    const server = new FakeServer();
    const alice = await phone(server);
    const bob = await phone(server);
    await introduce(server, alice, bob);
    await airplane(server, alice, bob);

    const queued = await send(alice, bob, 'when you are near');
    await eventually(
      async () => (await stateOf(alice, queued.messageId)) === 'waiting_for_nearby_route',
      3_000,
      'queued for a nearby route',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await stateOf(alice, queued.messageId)).toBe('waiting_for_nearby_route');

    inRange(alice, bob);
    await eventually(() => textsOf(bob).includes('when you are near'), 5_000, 'flushed');
    await eventually(
      async () => (await stateOf(alice, queued.messageId)) === 'delivered_to_recipient_device',
      5_000,
    );
  });

  it('does not duplicate a message that went nearby and then, unacknowledged, over the Internet', async () => {
    const server = new FakeServer();
    const alice = await phone(server);
    const bob = await phone(server);
    await introduce(server, alice, bob);
    await airplane(server, alice, bob);
    inRange(alice, bob);
    await eventually(() => alice.nearby.reaches(bob.client.deviceId), 3_000, 'handshake');

    // Bob stores it, but nothing Bob sends gets back: no ACK, no receipt.
    bob.radio.mute = true;
    const message = await send(alice, bob, 'twice?');
    await eventually(() => textsOf(bob).includes('twice?'), 5_000, 'bob has it');
    // Alice's nearby send timed out, so it is queued again.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await stateOf(alice, message.messageId)).not.toBe('delivered_to_recipient_device');

    // The Internet comes back on both phones.
    server.apiDown = false;
    alice.client.transport.connect();
    bob.client.transport.connect();
    await eventually(
      async () => (await stateOf(alice, message.messageId)) === 'delivered_to_recipient_device',
      5_000,
      'delivered once the receipt goes through the server',
    );
    await bob.client.engine.idle();
    expect(textsOf(bob).filter((t) => t === 'twice?')).toHaveLength(1);
    expect(textsOf(alice).filter((t) => t === 'twice?')).toHaveLength(1);
  });

  it("gives the sender's own linked browser its copy once the Internet is back", async () => {
    const server = new FakeServer();
    const alice = await phone(server);
    const bob = await phone(server);
    const browser = await createTestClient(server, crypto, {
      sameUserAs: alice.client,
      platform: 'web',
    });
    running.push({
      client: browser,
      nearby: new NearbyPeerTransport({
        links: new FakeLinks(),
        identity: createNearbyIdentity({
          self: { userId: browser.userId, deviceId: browser.deviceId },
          crypto,
          account: browser.account,
          store: browser.store,
        }),
      }),
    });
    // Alice's phone knows Bob's directory but not its own (never fetched).
    await introduce(server, alice, bob);
    await airplane(server, alice, bob);
    inRange(alice, bob);
    await eventually(() => alice.nearby.reaches(bob.client.deviceId), 3_000, 'handshake');
    await send(alice, bob, 'for every device');
    await eventually(() => textsOf(bob).includes('for every device'), 5_000, 'bob first');

    server.apiDown = false;
    alice.client.transport.connect();
    browser.transport.connect();
    await browser.engine.start();
    await eventually(
      () => browser.store.allMessages().some((m) => m.body === 'for every device'),
      5_000,
      'the browser gets its copy later',
    );
  });

  it('prefers the Internet when both paths are up', async () => {
    const server = new FakeServer();
    const alice = await phone(server);
    const bob = await phone(server);
    await introduce(server, alice, bob);
    await alice.nearby.start();
    await bob.nearby.start();
    inRange(alice, bob);
    await eventually(() => alice.nearby.reaches(bob.client.deviceId), 3_000, 'handshake');
    const message = await send(alice, bob, 'online');
    await eventually(
      async () => (await stateOf(alice, message.messageId)) === 'delivered_to_recipient_device',
    );
    const info = await alice.client.engine.messageInfo(message.messageId);
    expect(info?.deliveries[0]?.via).toBe('internet');
  });

  it('knows whether a contact can be reached offline', async () => {
    const server = new FakeServer();
    const alice = await phone(server);
    const bob = await phone(server);
    alice.client.transport.connect();
    await alice.client.engine.start();
    expect(await alice.client.engine.canReachOffline(bob.client.userId)).toBe(false);
    await alice.client.engine.refreshDevices(bob.client.userId);
    expect(await alice.client.engine.canReachOffline(bob.client.userId)).toBe(true);
  });
});

describe('createNearbyIdentity', () => {
  it('recognises a cached contact device by its key, and nothing else', async () => {
    const server = new FakeServer();
    const alice = await phone(server);
    const bob = await phone(server);
    await introduce(server, alice, bob);
    const store = alice.client.store;
    const own = { userId: alice.client.userId, deviceId: alice.client.deviceId };
    const identity = createNearbyIdentity({
      self: own,
      crypto,
      account: alice.client.account,
      store,
    });
    const bobKey = bob.client.account.identityKeys().ed25519;
    const message = nearbyHelloMessage(new Uint8Array(16), new Uint8Array(16).fill(1), bobKey, 1);
    const signature = bob.client.account.sign(message);

    expect(await identity.check(bobKey, message, signature)).toEqual({
      status: 'known',
      peer: { userId: bob.client.userId, deviceId: bob.client.deviceId },
    });
    // A changed byte, a stranger's valid key, and a blocked contact.
    const tampered = Uint8Array.from(message, (b, i) => (i === message.length - 1 ? b ^ 1 : b));
    expect(await identity.check(bobKey, tampered, signature)).toEqual({ status: 'invalid' });
    const stranger = crypto.createAccount();
    const strangerKey = stranger.identityKeys().ed25519;
    const strangerMessage = nearbyHelloMessage(
      new Uint8Array(16),
      new Uint8Array(16),
      strangerKey,
      1,
    );
    expect(
      await identity.check(strangerKey, strangerMessage, stranger.sign(strangerMessage)),
    ).toEqual({ status: 'unknown' });
    const blocking = createNearbyIdentity({
      self: own,
      crypto,
      account: alice.client.account,
      store,
      blocked: (userId) => userId === bob.client.userId,
    });
    expect(await blocking.check(bobKey, message, signature)).toEqual({ status: 'unknown' });
    expect(await identity.check('not a key', message, signature)).toEqual({ status: 'invalid' });
    void MemoryEngineStore;
  });
});
