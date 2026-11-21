/**
 * Games through the engine (ADR 0049) over the in-memory fake server with real vodozemac:
 * events go out as control items (Olm one to one, Megolm in groups), are stored on every
 * device, a `create` files the invitation card, a seat's secret never leaves its device, and
 * the circle rule and chat deletion apply.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { decodeGame, fromBase64, GameType, uuidToBytes } from '@pingdost/protocol';

import { readGameCard } from './games';
import { createTestClient, eventually, FakeServer, type TestClient } from './testing';

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

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

const ludo = {
  event: {
    case: 'create' as const,
    value: {
      type: GameType.LUDO,
      maxPlayers: 2,
      settings: { case: 'ludo' as const, value: {} },
      anchor: bytes(32, 1),
      salt: bytes(16, 2),
    },
  },
};

describe('games through the engine', () => {
  it('sends a game one to one: card, events and a seat secret that stays home', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    await online(alice, bob);
    const seen: string[] = [];
    bob.engine.onGameEvent((event) => seen.push(event.eventId));

    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const created = await alice.engine.sendGameEvent(conversationId, ludo, {
      seatSeed: 'aG9zdA==',
    });
    const { gameId } = created;
    // The game ID is the create's own message ID.
    expect(gameId).toBe(created.eventId);
    expect((await alice.engine.getGame(gameId))?.seatSeed).toBe('aG9zdA==');

    await eventually(
      async () => (await bob.engine.getGame(gameId)) !== undefined,
      5_000,
      'bob has the game',
    );
    const bobGame = await bob.engine.getGame(gameId);
    expect(bobGame).toMatchObject({ gameType: 'ludo', createdBy: alice.userId, seatSeed: null });
    const card = await bob.engine.getMessage(gameId);
    expect(card).toMatchObject({ kind: 'game', direction: 'in', senderUserId: alice.userId });
    expect(readGameCard(card!.body)).toEqual({ gameId, type: 'ludo' });
    expect((await bob.engine.getConversation(conversationId))?.unreadCount).toBe(1);

    // Bob joins: his secret is kept with the game on his device only.
    await bob.engine.sendGameEvent(
      conversationId,
      {
        gameId: uuidToBytes(gameId),
        event: { case: 'join', value: { anchor: bytes(32, 3), salt: bytes(16, 4) } },
      },
      { seatSeed: 'Ym9i' },
    );
    await eventually(
      async () => (await alice.engine.listGameEvents(gameId)).length === 2,
      5_000,
      'alice has the join',
    );
    const [first, join] = await alice.engine.listGameEvents(gameId);
    expect(first?.eventId).toBe(gameId);
    expect(join).toMatchObject({ senderUserId: bob.userId, senderDeviceId: bob.deviceId });
    expect(decodeGame(fromBase64(join!.payload)).event.case).toBe('join');
    expect((await alice.engine.getGame(gameId))?.seatSeed).toBe('aG9zdA==');
    expect((await bob.engine.getGame(gameId))?.seatSeed).toBe('Ym9i');
    // Every event reached Bob's listener once, his own included.
    expect(seen).toEqual([gameId, join!.eventId]);
    // No secret went over the wire: the server only ever saw ciphertext.
    const wire = server.accepted.map((p) => Buffer.from(p.payload).toString('latin1')).join('');
    expect(wire).not.toContain('Ym9i');
  });

  it('plays in a group: every member gets each event over Megolm', async () => {
    const server = new FakeServer();
    const alice = await client(server);
    const bob = await client(server);
    const carol = await client(server);
    await online(alice, bob, carol);
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Ludo night',
      memberUserIds: [bob.userId, carol.userId],
    });
    const { gameId } = await alice.engine.sendGameEvent(groupId, ludo);
    for (const member of [bob, carol]) {
      await eventually(
        async () => (await member.engine.getMessage(gameId))?.kind === 'game',
        5_000,
        'card arrives',
      );
    }
    await carol.engine.sendGameEvent(groupId, {
      gameId: uuidToBytes(gameId),
      event: { case: 'emote', value: { emoji: '🎉' } },
    });
    for (const member of [alice, bob]) {
      await eventually(
        async () => (await member.engine.listGameEvents(gameId)).length === 2,
        5_000,
        'emote arrives',
      );
    }
  });

  it('drops a game from outside the circle, and deletes games with their chat', async () => {
    const server = new FakeServer();
    const circle = new Set<string>();
    const alice = await client(server);
    const bob = await client(server, { circle: (userId) => circle.has(userId) });
    await online(alice, bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const stranger = await alice.engine.sendGameEvent(conversationId, ludo);
    await eventually(() => server.accepted.length > 0, 5_000, 'sent');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await bob.engine.getGame(stranger.gameId)).toBeUndefined();
    expect(await bob.engine.getMessage(stranger.gameId)).toBeUndefined();

    circle.add(alice.userId);
    const friend = await alice.engine.sendGameEvent(conversationId, ludo);
    await eventually(
      async () => (await bob.engine.getGame(friend.gameId)) !== undefined,
      5_000,
      'arrives',
    );
    await bob.engine.deleteConversation(conversationId);
    expect(await bob.engine.listGames()).toEqual([]);
    expect(await bob.engine.listGameEvents(friend.gameId)).toEqual([]);
  });
});
