/**
 * Circles in the engine (Phase 37, ADR 0041): on nearby and mesh routes no server checks the
 * circle, so the receiving engine drops one-to-one content from outside it, without a receipt.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { NearbyPeerTransport, TransportRouter } from '@pingdost/transport';
import { connectFakeLinks, FakeLinks } from '@pingdost/transport/testing';

import { MeshSim, type SimPhone } from '../mesh/sim';
import { createTestClient, eventually, FakeServer, type TestClient } from '../testing';
import { createNearbyIdentity } from './identity';

let crypto: CryptoProvider;
const running: { client: TestClient; nearby: NearbyPeerTransport }[] = [];
let sim: MeshSim | undefined;

beforeAll(async () => {
  crypto = await createWasmCryptoProvider();
});

afterEach(async () => {
  for (const { client, nearby } of running.splice(0)) {
    nearby.dispose();
    await client.engine.stop();
  }
  await sim?.stop();
  sim = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nearbyPhone(server: FakeServer, circle?: (userId: string) => boolean | undefined) {
  const radio = new FakeLinks();
  let nearby: NearbyPeerTransport | undefined;
  const client = await createTestClient(server, crypto, {
    ...(circle ? { circle } : {}),
    transport: ({ internet, userId, deviceId, account, store }) => {
      nearby = new NearbyPeerTransport({
        links: radio,
        identity: createNearbyIdentity({ self: { userId, deviceId }, crypto, account, store }),
        ackTimeoutMs: 300,
        handshakeTimeoutMs: 1_000,
      });
      return new TransportRouter([internet, nearby]);
    },
  });
  if (!nearby) throw new Error('no nearby transport');
  running.push({ client, nearby });
  return { client, nearby, radio };
}

type Phone = Awaited<ReturnType<typeof nearbyPhone>>;

async function send(from: TestClient, to: TestClient, text: string) {
  const conversation = await from.engine.openDirectConversation(to.userId);
  return from.engine.sendText(conversation.conversationId, text);
}

const textsOf = (client: TestClient) =>
  client.store
    .allMessages()
    .filter((m) => m.kind === 'text')
    .map((m) => m.body);

describe('circles over nearby and the mesh', () => {
  it('drops nearby text from outside the circle, sends no receipt, and keeps the circle’s', async () => {
    const server = new FakeServer();
    const circle = new Set<string>();
    const bob = await nearbyPhone(server, (userId) => circle.has(userId));
    const alice = await nearbyPhone(server);
    const carol = await nearbyPhone(server);
    circle.add(carol.client.userId);
    const all: Phone[] = [alice, bob, carol];
    for (const p of all) {
      p.client.transport.connect();
      await p.client.engine.start();
    }
    for (const p of all) {
      for (const other of all) {
        if (other !== p) await p.client.engine.refreshDevices(other.client.userId);
      }
    }
    server.apiDown = true;
    for (const p of all) {
      p.client.transport.disconnect();
      await p.nearby.start();
    }
    connectFakeLinks(alice.radio, bob.radio);
    connectFakeLinks(carol.radio, bob.radio);
    await eventually(() => alice.nearby.reaches(bob.client.deviceId), 3_000, 'alice linked');
    await eventually(() => carol.nearby.reaches(bob.client.deviceId), 3_000, 'carol linked');

    const stranger = await send(alice.client, bob.client, 'from outside the circle');
    const friend = await send(carol.client, bob.client, 'from the circle');
    await eventually(() => textsOf(bob.client).includes('from the circle'), 5_000, 'carol arrives');
    await eventually(
      async () =>
        (await carol.client.engine.getMessage(friend.messageId))?.state ===
        'delivered_to_recipient_device',
      5_000,
      'carol gets the receipt',
    );
    // Alice's text reached Bob's phone over Bluetooth and was dropped there: no message, no
    // conversation, no receipt (her side stays at the nearby hop's "sent").
    await sleep(500);
    expect(textsOf(bob.client)).not.toContain('from outside the circle');
    expect(
      (await bob.client.engine.listConversations()).some(
        (c) => c.kind === 'direct' && c.peerUserId === alice.client.userId,
      ),
    ).toBe(false);
    expect((await alice.client.engine.getMessage(stranger.messageId))?.state).not.toBe(
      'delivered_to_recipient_device',
    );
  });

  it('drops a mesh-relayed text from outside the circle at the recipient', async () => {
    sim = new MeshSim(crypto);
    const circle = new Set<string>();
    const a = await sim.phone('A');
    const b = await sim.phone('B', { relaying: true });
    const c: SimPhone = await sim.phone('C', { circle: (userId) => circle.has(userId) });
    await sim.introduce(a, c);
    await sim.airplane();
    const conversation = await a.client.engine.openDirectConversation(c.client.userId);
    await a.client.engine.sendText(conversation.conversationId, 'relayed from a stranger');
    sim.meet(a, b);
    await eventually(() => sim!.meshOf(b).stored.packets === 1, 5_000, 'B carries it');
    sim.part(a, b);
    sim.meet(b, c);
    await eventually(() => sim!.meshOf(b).handedOver === 1, 5_000, 'B handed it over');
    await sleep(500);
    expect(textsOf(c.client)).not.toContain('relayed from a stranger');
    // No receipt went back into C's mesh.
    expect(sim.meshOf(c).own).toBe(0);
  });

  it('drops nothing while the circle has never been loaded on the device', async () => {
    sim = new MeshSim(crypto);
    const a = await sim.phone('A');
    const b = await sim.phone('B', { relaying: true });
    const c = await sim.phone('C', { circle: () => undefined });
    await sim.introduce(a, c);
    await sim.airplane();
    const conversation = await a.client.engine.openDirectConversation(c.client.userId);
    await a.client.engine.sendText(conversation.conversationId, 'before the list loads');
    sim.meet(a, b);
    await eventually(() => sim!.meshOf(b).stored.packets === 1, 5_000, 'B carries it');
    sim.part(a, b);
    sim.meet(b, c);
    await eventually(
      () => textsOf(c.client).includes('before the list loads'),
      5_000,
      'C keeps it',
    );
  });
});
