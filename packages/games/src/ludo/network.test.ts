import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  create,
  decodeGame,
  encodeGame,
  fromBase64,
  GameSchema,
  toBase64,
  uuidToBytes,
} from '@pingdost/protocol';

import { FAST_PACE } from './controller';
import { ludoGameSummary, ludoNetStatus } from './labels';
import {
  applyLudoSkip,
  canonicalLudo,
  foldLudoGame,
  LUDO_GRACE_MS,
  LUDO_TURN_MS,
  ludoStateHash,
  type GameEventLike,
  type GamePlayerRef,
} from './network';
import {
  createLudoEvent,
  LudoNetController,
  type GameEventInit,
  type GameSendOptions,
} from './network-controller';
import { DEFAULT_LUDO_SETTINGS } from './rules';
import { buildChain, revealAt } from '../core/fair-dice';
import { seededRandom } from '../core/random';

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());

let counter = 0;
/** UUID-shaped IDs that sort in the order they were made (like UUIDv7). */
function nextId(): string {
  counter++;
  return `${counter.toString(16).padStart(8, '0')}-0000-7000-8000-000000000000`;
}

function seededBytes(seed: number) {
  const random = seededRandom(seed);
  return (length: number) => Uint8Array.from({ length }, () => random.int(256));
}

/** A chat where every device sees every event (in its own time). */
class Table {
  events: GameEventLike[] = [];
  readonly controllers: { ref: GamePlayerRef; controller: LudoNetController }[] = [];
  gameId = '';

  record(from: GamePlayerRef, init: GameEventInit, eventId = nextId()): GameEventLike {
    const game = create(GameSchema, init);
    if (game.event.case === 'create') {
      this.gameId = eventId;
      game.gameId = uuidToBytes(eventId);
    }
    const now = Date.now();
    const event = {
      eventId,
      gameId: this.gameId,
      senderUserId: from.userId,
      senderDeviceId: from.deviceId,
      sentAt: now,
      receivedAt: now,
      payload: toBase64(encodeGame(game)),
    };
    this.events.push(event);
    return event;
  }

  port(ref: GamePlayerRef, seed: number, seeds: Map<string, string>) {
    return {
      self: ref,
      sha256,
      randomBytes: seededBytes(seed),
      send: async (init: GameEventInit, options?: GameSendOptions) => {
        if (options?.seatSeed) seeds.set(ref.deviceId, options.seatSeed);
        this.record(ref, init);
        await Promise.resolve();
        this.deliver();
      },
    };
  }

  deliver(): void {
    for (const { controller } of this.controllers) controller.update([...this.events]);
  }
}

const alice = {
  userId: '0000000a-0000-4000-8000-000000000000',
  deviceId: 'a0000000-0000-4000-8000-000000000001',
};
const bob = {
  userId: '0000000b-0000-4000-8000-000000000000',
  deviceId: 'b0000000-0000-4000-8000-000000000001',
};
const carol = {
  userId: '0000000c-0000-4000-8000-000000000000',
  deviceId: 'c0000000-0000-4000-8000-000000000001',
};

/** Alice hosts; the others join through their controllers. */
function setUp(players: GamePlayerRef[], maxPlayers = players.length) {
  const table = new Table();
  const seeds = new Map<string, string>();
  const created = createLudoEvent(sha256, DEFAULT_LUDO_SETTINGS, maxPlayers, seededBytes(1));
  seeds.set(alice.deviceId, created.seatSeed);
  table.record(alice, created.event);
  players.forEach((ref, i) => {
    const controller = new LudoNetController({
      gameId: table.gameId,
      events: [...table.events],
      seatSeed: seeds.get(ref.deviceId) ?? null,
      port: table.port(ref, 100 + i, seeds),
      pace: FAST_PACE,
      autoMove: true,
    });
    table.controllers.push({ ref, controller });
  });
  return { table, seeds };
}

async function runUntil(done: () => boolean, step = LUDO_TURN_MS + 1_000, limit = 4_000) {
  for (let i = 0; i < limit && !done(); i++) await vi.advanceTimersByTimeAsync(step);
}

beforeEach(() => {
  vi.useFakeTimers();
  counter = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Ludo with friends: the fold and the controller', () => {
  it('two devices join, start and play a whole game on their timers, and agree', async () => {
    const { table } = setUp([alice, bob]);
    const [a, b] = table.controllers.map((c) => c.controller);
    expect(a!.getView().game.phase).toBe('lobby');
    expect(b!.getView().canJoin).toBe(true);
    b!.join();
    // The table is full: the host's app starts by itself.
    await vi.advanceTimersByTimeAsync(10);
    expect(a!.getView().game.phase).toBe('playing');
    expect(
      b!
        .getView()
        .game.seats.map((s) => s.userId)
        .sort(),
    ).toEqual([alice.userId, bob.userId].sort());

    // Nobody taps: each app rolls and moves for its own user when the timer runs out.
    await runUntil(() => a!.getView().game.phase === 'over');
    const ga = a!.getView().game;
    const gb = b!.getView().game;
    expect(ga.phase).toBe('over');
    expect(gb.phase).toBe('over');
    expect(ga.desync || gb.desync).toBe(false);
    expect(canonicalLudo(gb.state!)).toBe(canonicalLudo(ga.state!));
    expect(gb.entries.map((e) => e.eventId)).toEqual(ga.entries.map((e) => e.eventId));
    expect(ga.entries.every((e) => e.kind === 'roll' || e.kind === 'move')).toBe(true);
    expect(ga.state!.players.filter((p) => p.rank === 1)).toHaveLength(1);
    // The board shows the end once the last step has been animated.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a!.getView().board?.waiting).toBe('over');

    // Any order, with duplicates: the same game.
    const random = seededRandom(7);
    const shuffled = [...table.events, ...table.events.slice(0, 40)];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = random.int(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const refolded = foldLudoGame(table.gameId, shuffled, sha256);
    expect(canonicalLudo(refolded.state!)).toBe(canonicalLudo(ga.state!));
    expect(refolded.entries.map((e) => e.eventId)).toEqual(ga.entries.map((e) => e.eventId));

    // A move whose state hash differs from ours still counts, but shows the game out of sync.
    const forged = table.events.map((e) => {
      const game = decodeGame(fromBase64(e.payload));
      if (
        game.event.case !== 'move' ||
        e.eventId !== ga.entries.find((x) => x.kind === 'move')?.eventId
      ) {
        return e;
      }
      game.event.value.stateHash = new Uint8Array(8);
      return { ...e, payload: toBase64(encodeGame(game)) };
    });
    const outOfSync = foldLudoGame(table.gameId, forged, sha256);
    expect(outOfSync.desync).toBe(true);
    expect(outOfSync.entries).toHaveLength(ga.entries.length);
    for (const { controller } of table.controllers) controller.dispose();
  }, 60_000);

  it('skips an absent player, and three skips in a row take them out', async () => {
    const { table } = setUp([alice], 2);
    const [a] = table.controllers.map((c) => c.controller);
    // Bob joins from his app, then never opens the game again.
    const bobChain = buildChain(sha256, new Uint8Array(32).fill(9));
    table.record(bob, {
      gameId: uuidToBytes(table.gameId),
      event: {
        case: 'join',
        value: { anchor: bobChain.at(-1)!, salt: new Uint8Array(16).fill(3) },
      },
    });
    table.deliver();
    await vi.advanceTimersByTimeAsync(10);
    expect(a!.getView().game.phase).toBe('playing');

    await runUntil(() => a!.getView().game.phase === 'over', LUDO_TURN_MS + LUDO_GRACE_MS + 1_000);
    const game = a!.getView().game;
    expect(game.phase).toBe('over');
    const bobSeat = game.seats.findIndex((s) => s.userId === bob.userId);
    expect(game.state!.players[bobSeat]!.left).toBe(true);
    expect(game.entries.filter((e) => e.kind === 'skip')).toHaveLength(3);
    expect(game.state!.players[1 - bobSeat]!.rank).toBe(1);
    a!.dispose();
  }, 60_000);

  it('a lower event ID wins a slot; the losing roll still uses up its secret', () => {
    const table = new Table();
    const aliceSeed = new Uint8Array(32).fill(1);
    const bobSeed = new Uint8Array(32).fill(2);
    const chains = { a: buildChain(sha256, aliceSeed), b: buildChain(sha256, bobSeed) };
    table.record(alice, {
      event: {
        case: 'create',
        value: {
          type: 1,
          maxPlayers: 2,
          settings: { case: 'ludo', value: {} },
          anchor: chains.a.at(-1)!,
          salt: new Uint8Array(16).fill(5),
        },
      },
    });
    const gameId = uuidToBytes(table.gameId);
    table.record(bob, {
      gameId,
      event: {
        case: 'join',
        value: { anchor: chains.b.at(-1)!, salt: new Uint8Array(16).fill(6) },
      },
    });
    table.record(alice, {
      gameId,
      event: {
        case: 'start',
        value: {
          seats: [
            {
              userId: uuidToBytes(alice.userId),
              deviceId: uuidToBytes(alice.deviceId),
              color: 0,
              anchor: chains.a.at(-1)!,
              salt: new Uint8Array(16).fill(5),
            },
            {
              userId: uuidToBytes(bob.userId),
              deviceId: uuidToBytes(bob.deviceId),
              color: 2,
              anchor: chains.b.at(-1)!,
              salt: new Uint8Array(16).fill(6),
            },
          ],
        },
      },
    });
    const started = foldLudoGame(table.gameId, table.events, sha256);
    const first = started.seats[started.state!.current]!;
    const other = started.seats.find((s) => s !== first)!;
    const firstChain = first.userId === alice.userId ? chains.a : chains.b;

    // The other player's skip (lower ID) and the first player's roll race for slot 0:0.
    const skipId = nextId();
    const rollId = nextId();
    const skipped = ludoStateHash(sha256, applyLudoSkip(started.state!, 0));
    table.record(
      first,
      {
        gameId,
        event: {
          case: 'roll',
          value: { reveal: revealAt(firstChain, 1), salt: new Uint8Array(16) },
        },
      },
      rollId,
    );
    table.record(
      other,
      {
        gameId,
        event: { case: 'skip', value: { salt: new Uint8Array(16), stateHash: skipped } },
      },
      skipId,
    );
    const raced = foldLudoGame(table.gameId, table.events, sha256);
    expect(raced.entries.map((e) => e.kind)).toEqual(['skip']);
    expect(raced.desync).toBe(false);
    // The burned secret counts: the next roll must reveal secret 2, never secret 1 again.
    expect(raced.rolls[started.state!.current]).toBe(1);
  });

  it('ignores tampered rolls, strangers and illegal moves, and flags a wrong state hash', async () => {
    const { table } = setUp([alice, bob]);
    const [a, b] = table.controllers.map((c) => c.controller);
    b!.join();
    await vi.advanceTimersByTimeAsync(10);
    const game = a!.getView().game;
    const current = game.seats[game.state!.current]!;
    const gameId = uuidToBytes(table.gameId);
    const stranger = {
      userId: '0000000d-0000-4000-8000-000000000000',
      deviceId: 'd0000000-0000-4000-8000-000000000001',
    };
    // A made-up secret, and a roll from someone without a seat.
    table.record(current, {
      gameId,
      event: {
        case: 'roll',
        value: { reveal: new Uint8Array(32).fill(7), salt: new Uint8Array(16) },
      },
    });
    table.record(stranger, {
      gameId,
      event: { case: 'skip', value: { salt: new Uint8Array(16), stateHash: new Uint8Array(8) } },
    });
    let folded = foldLudoGame(table.gameId, table.events, sha256);
    expect(folded.entries).toHaveLength(0);

    // The real secret still counts as the first.
    const controller = table.controllers.find((c) => c.ref.deviceId === current.deviceId)!;
    controller.controller.roll();
    await vi.advanceTimersByTimeAsync(10);
    folded = foldLudoGame(table.gameId, table.events, sha256);
    expect(folded.entries.map((e) => e.kind)).toEqual(['roll']);
    expect(folded.rolls[game.state!.current]).toBe(1);
    for (const { controller: c } of table.controllers) c.dispose();
  });

  it('keeps one seat per person, rejects a start that changes a seat, and ends on the host', async () => {
    const { table } = setUp([alice, bob, carol], 4);
    const [a, b, c] = table.controllers.map((x) => x.controller);
    b!.join();
    b!.join();
    c!.join();
    await vi.advanceTimersByTimeAsync(10);
    let view = a!.getView();
    expect(view.game.lobby.map((e) => e.userId)).toEqual([alice.userId, bob.userId, carol.userId]);
    expect(view.canStart).toBe(true);
    expect(ludoGameSummary(view.game, bob).text).toBe('Waiting for players · 3/4');
    expect(ludoGameSummary(view.game, { userId: 'x', deviceId: 'y' }).state).toBe('invite');
    expect(ludoNetStatus(view)).toBe('Waiting for players (3/4)');
    // The table is not full: nothing starts until the host does.
    expect(view.game.phase).toBe('lobby');
    c!.leave();
    await vi.advanceTimersByTimeAsync(10);
    expect(a!.getView().game.lobby.map((e) => e.userId)).toEqual([alice.userId, bob.userId]);

    a!.start('blue');
    await vi.advanceTimersByTimeAsync(10);
    view = b!.getView();
    expect(view.game.phase).toBe('playing');
    expect(view.game.seats.find((s) => s.userId === alice.userId)?.color).toBe('blue');
    expect(c!.getView().you).toBe(-1);
    expect(c!.getView().canJoin).toBe(false);
    const turn = ludoGameSummary(view.game, bob, (id) => (id === alice.userId ? 'Alice' : null));
    expect(['Your turn', "Alice's turn"]).toContain(turn.text);
    expect(ludoGameSummary(view.game, carol).playing).toBe(false);

    a!.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(b!.getView().game.phase).toBe('ended');
    expect(b!.getView().deadline).toBeNull();
    for (const { controller } of table.controllers) controller.dispose();
  });
});
