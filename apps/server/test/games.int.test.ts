/**
 * Ludo with friends (Phase 42, ADR 0049) on the real server, with sim clients (real E2EE):
 * - one to one: invite, join, the host's app starts it, both play; one side drops offline
 *   mid-game and catches up from its mailbox; both fold the same game; the host ends it;
 * - a group of four: three seats and a watcher, a player leaves mid-game;
 * - a stranger's game never reaches anyone (circles, Phase 37);
 * - the server only ever sees ciphertext: no emote text and no seat secret in any frame.
 */
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import {
  canonicalLudo,
  CONNECT_FOUR,
  SNAKES_AND_LADDERS,
  ZERO_TURN_PACE,
  type LudoNetView,
  type LudoPace,
  type SnakesState,
} from '@pingdost/games';
import { fromBase64, GameType } from '@pingdost/protocol';
import {
  capturingSocket,
  containsMarker,
  SimClient,
  simGames,
  type SimClientOptions,
  type SimGames,
} from '@pingdost/sim-client';

import { cryptoProvider } from './devices';
import { MAILPIT_URL, startTestServer, type TestServer } from './helpers';

const INSTANT: LudoPace = { roll: 0, hop: 0, capture: 0, read: 0, think: 0 };

let crypto: CryptoProvider;
let server: TestServer;
let port = 0;
const clients: SimClient[] = [];
const games: SimGames[] = [];
const frames: Uint8Array[] = [];

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    throttles: { keyClaims: { limit: 10_000, windowMs: 3_600_000 } },
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  port = (server.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const g of games) g.stop();
  for (const client of clients) await client.stop().catch(() => undefined);
  await server.close();
});

function options(): SimClientOptions {
  return {
    endpoints: {
      api: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/v1/ws`,
      mailpit: MAILPIT_URL,
    },
    crypto,
    settings: { directoryMaxAgeMs: 0, receiptDelayMs: 50, retry: { baseMs: 200, maxMs: 1_000 } },
    createSocket: capturingSocket(frames),
  };
}

async function sim(linkTo: SimClient[] = []): Promise<SimClient> {
  const client = await SimClient.register(options());
  for (const other of linkTo) await client.linkWith(other);
  clients.push(client);
  await client.start();
  return client;
}

function play(client: SimClient, autoJoin = true): SimGames {
  // 100 ms per action: quick, without starving the other suites that run beside this file.
  const g = simGames(client, crypto, {
    autoJoin,
    thinkMs: 100,
    pace: INSTANT,
    turnPace: ZERO_TURN_PACE,
  });
  games.push(g);
  return g;
}

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Waits until two devices see the same finished game (same phase, same steps). */
async function agreed(
  gameId: string,
  one: SimGames,
  two: SimGames,
): Promise<[LudoNetView, LudoNetView]> {
  const same = (a?: LudoNetView, b?: LudoNetView) =>
    !!a &&
    !!b &&
    a.game.phase !== 'playing' &&
    a.game.phase === b.game.phase &&
    a.game.entries.map((e) => e.eventId).join() === b.game.entries.map((e) => e.eventId).join();
  await until(() => same(one.view(gameId), two.view(gameId)), 'both see the same end');
  return [one.view(gameId)!, two.view(gameId)!];
}

describe('Quick games with friends through the server (Phase 43)', () => {
  it('plays Connect Four one to one to the end', async () => {
    const alice = await sim();
    const bob = await sim([alice]);
    const ga = play(alice);
    const gb = play(bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const gameId = await ga.createTurn(conversationId, 'connect-four');
    await until(async () => (await bob.engine.getMessage(gameId))?.kind === 'game', 'the card');
    expect((await bob.engine.getGame(gameId))?.gameType).toBe('connect-four');
    const done = (phase?: string) => phase === 'over';
    const a = await ga.untilTurn(gameId, (v) => done(v.game.phase), 60_000);
    const b = await gb.untilTurn(
      gameId,
      (v) => done(v.game.phase) && v.game.entries.length === a.game.entries.length,
      30_000,
    );
    expect(a.game.desync || b.game.desync).toBe(false);
    expect(CONNECT_FOUR.canonical(b.game.state as never)).toBe(
      CONNECT_FOUR.canonical(a.game.state as never),
    );
    expect(a.game.entries.every((e) => e.kind === 'move')).toBe(true);
  }, 120_000);

  it('plays Snakes and Ladders in a group of three with fair dice', async () => {
    const alice = await sim();
    const bob = await sim([alice]);
    const carol = await sim([alice, bob]);
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Snakes',
      memberUserIds: [bob.userId, carol.userId],
    });
    const [ga, gb, gc] = [play(alice), play(bob), play(carol)];
    const gameId = await ga.createTurn(groupId, 'snakes-and-ladders', { maxPlayers: 3 });
    const a = await ga.untilTurn(gameId, (v) => v.game.phase === 'over', 90_000);
    const steps = a.game.entries.length;
    for (const g of [gb, gc]) {
      const v = await g.untilTurn(
        gameId,
        (x) => x.game.phase === 'over' && x.game.entries.length === steps,
        30_000,
      );
      expect(v.game.desync).toBe(false);
      expect(v.game.entries.map((e) => e.die)).toEqual(a.game.entries.map((e) => e.die));
    }
    expect(a.game.seats).toHaveLength(3);
    expect((a.game.state as SnakesState).positions).toContain(100);
    expect(SNAKES_AND_LADDERS.canonical(a.game.state as SnakesState)).toBeTruthy();
  }, 150_000);
});

describe('Ludo with friends through the server', () => {
  it('plays one to one, catches up after going offline, and ends on the host', async () => {
    const alice = await sim();
    const bob = await sim([alice]);
    const ga = play(alice);
    const gb = play(bob);
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    const gameId = await ga.createLudo(conversationId);

    // Bob's app shows the invitation card, joins, and the host's app starts the game.
    await until(async () => (await bob.engine.getMessage(gameId))?.kind === 'game', 'the card');
    await ga.until(gameId, (v) => v.game.phase === 'playing');
    await gb.until(gameId, (v) => v.game.phase === 'playing');
    await ga.until(gameId, (v) => v.game.entries.length >= 10);

    // Bob drops offline: the game waits for him, then his mailbox catches him up.
    bob.transport.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    bob.transport.start();
    const target = (ga.view(gameId)?.game.entries.length ?? 0) + 20;
    await ga.until(
      gameId,
      (v) => v.game.entries.length >= target || v.game.phase === 'over',
      60_000,
    );

    ga.controller(gameId)!.end();
    // Moves sent just before the end can still arrive after it: wait until both sides agree.
    const [a, b] = await agreed(gameId, ga, gb);
    expect(a.game.desync || b.game.desync).toBe(false);
    expect(b.game.entries.map((e) => e.eventId)).toEqual(a.game.entries.map((e) => e.eventId));
    expect(canonicalLudo(b.game.state!)).toBe(canonicalLudo(a.game.state!));
    // Each side keeps its own seat secret; neither has the other's.
    const [aRecord, bRecord] = [
      await alice.engine.getGame(gameId),
      await bob.engine.getGame(gameId),
    ];
    expect(aRecord?.seatSeed).toBeTruthy();
    expect(bRecord?.seatSeed).toBeTruthy();
    expect(aRecord?.seatSeed).not.toBe(bRecord?.seatSeed);
    for (const seed of [aRecord!.seatSeed!, bRecord!.seatSeed!]) {
      expect(frames.some((f) => containsMarker(f, seed))).toBe(false);
      const raw = fromBase64(seed);
      expect(frames.some((f) => Buffer.from(f).includes(Buffer.from(raw)))).toBe(false);
    }
  }, 120_000);

  it('plays in a group with a watcher, and a player leaves mid-game', async () => {
    const alice = await sim();
    const bob = await sim([alice]);
    const carol = await sim([alice, bob]);
    const dave = await sim([alice, bob, carol]);
    const { conversationId: groupId } = await alice.engine.createGroup({
      name: 'Ludo night',
      memberUserIds: [bob.userId, carol.userId, dave.userId],
    });
    await until(
      async () =>
        (await Promise.all([bob, carol, dave].map((c) => c.engine.getConversation(groupId)))).every(
          Boolean,
        ),
      'everyone in the group',
    );
    const ga = play(alice);
    play(bob);
    const gd = play(dave, false);
    const gameId = await ga.createLudo(groupId, { maxPlayers: 3 });
    await until(async () => (await carol.engine.getGame(gameId)) !== undefined, 'carol sees it');
    const gc = play(carol);

    await ga.until(gameId, (v) => v.game.phase === 'playing');
    const watching = await gd.until(gameId, (v) => v.game.phase === 'playing');
    expect(watching.you).toBe(-1);
    expect(watching.game.seats).toHaveLength(3);
    await ga.until(gameId, (v) => v.game.entries.length >= 12);

    // Carol leaves: it takes effect at her next turn.
    const marker = 'zq-emote-7x';
    gc.controller(gameId)!.emote(marker);
    gc.controller(gameId)!.leave();
    gc.stop();
    const carolSeat = watching.game.seats.findIndex((s) => s.userId === carol.userId);
    const after = await ga.until(
      gameId,
      (v) => v.game.phase === 'over' || v.game.state?.players[carolSeat]?.left === true,
      60_000,
    );
    expect(after.game.state!.players[carolSeat]!.left).toBe(true);
    await gd.until(gameId, (v) => v.game.emotes.some((e) => e.emoji === marker));
    ga.controller(gameId)!.end();
    const [final, seen] = await agreed(gameId, ga, gd);
    expect(canonicalLudo(seen.game.state!)).toBe(canonicalLudo(final.game.state!));
    // The emote travelled end-to-end encrypted only.
    expect(frames.some((f) => containsMarker(f, marker))).toBe(false);
  }, 120_000);

  it("never delivers a stranger's game", async () => {
    const alice = await sim();
    const stranger = await sim();
    const { conversationId } = await stranger.engine.openDirectConversation(alice.userId);
    const sent = await stranger.engine
      .sendGameEvent(conversationId, {
        event: {
          case: 'create',
          value: {
            type: GameType.LUDO,
            maxPlayers: 2,
            settings: { case: 'ludo', value: {} },
            anchor: new Uint8Array(32).fill(1),
            salt: new Uint8Array(16).fill(2),
          },
        },
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await alice.engine.listGames()).toEqual([]);
    if (sent) expect(await alice.engine.getMessage(sent.gameId)).toBeUndefined();
  });
});
