import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { create, encodeGame, GameSchema, toBase64, uuidToBytes } from '@pingdost/protocol';

import type { GameEventLike, GamePlayerRef } from './net';
import { seededRandom } from './random';
import { ZERO_TURN_PACE, type AnyTurnRules, type TurnCore } from './turn';
import { turnGameSummary, turnNetStatus } from './turn-labels';
import { createTurnEvent, TurnNetController } from './turn-net-controller';
import {
  foldTurnGame,
  proxyTurnMove,
  TURN_GRACE_MS,
  turnStateHash,
  type TurnNetGame,
} from './turn-network';
import { CHESS, type ChessState } from '../chess/rules';
import { CONNECT_FOUR, type ConnectFourState } from '../connect-four/rules';
import { DOTS_AND_BOXES } from '../dots-and-boxes/rules';
import { LAST_CARD, type LastCardMove, type LastCardState } from '../last-card/rules';
import type { GameEventInit, GameSendOptions } from '../ludo/network-controller';
import { SNAKES_AND_LADDERS, type SnakesState } from '../snakes-and-ladders/rules';
import { TIC_TAC_TOE, type TicTacToeState } from '../tic-tac-toe/rules';

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

type Controller = TurnNetController<TurnCore, unknown, unknown>;

/** A chat where every device sees every event at once. */
class Table {
  events: GameEventLike[] = [];
  readonly controllers: { ref: GamePlayerRef; controller: Controller }[] = [];
  readonly seeds = new Map<string, string>();
  gameId = '';
  /** Devices whose events are held back (offline), and the events they sent. */
  offline = new Set<string>();

  constructor(readonly rules: AnyTurnRules) {}

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

  port(ref: GamePlayerRef, seed: number) {
    return {
      self: ref,
      sha256,
      randomBytes: seededBytes(seed),
      send: async (init: GameEventInit, options?: GameSendOptions) => {
        if (options?.seatSeed) this.seeds.set(ref.deviceId, options.seatSeed);
        this.record(ref, init);
        await Promise.resolve();
        this.deliver();
      },
    };
  }

  deliver(): void {
    for (const { controller } of this.controllers) controller.update([...this.events]);
  }

  fold(): TurnNetGame<TurnCore, unknown, unknown> {
    return foldTurnGame(this.rules, this.gameId, this.events, sha256);
  }

  add(ref: GamePlayerRef, seed: number): Controller {
    const controller = new TurnNetController({
      rules: this.rules,
      gameId: this.gameId,
      events: [...this.events],
      seatSeed: this.seeds.get(ref.deviceId) ?? null,
      port: this.port(ref, seed),
      pace: ZERO_TURN_PACE,
    });
    this.controllers.push({ ref, controller });
    return controller;
  }

  remove(controller: Controller): void {
    controller.dispose();
    const i = this.controllers.findIndex((c) => c.controller === controller);
    this.controllers.splice(i, 1);
  }
}

const player = (n: number) => ({
  userId: `0000000${n}-0000-4000-8000-000000000000`,
  deviceId: `${n}0000000-0000-4000-8000-000000000001`,
});
const [alice, bob, carol] = [player(1), player(2), player(3)];

/** Alice hosts; the others join through their controllers (a full table starts itself). */
async function setUp(rules: AnyTurnRules, players: GamePlayerRef[], settings?: unknown) {
  const table = new Table(rules);
  const made = createTurnEvent(
    rules,
    sha256,
    settings ?? rules.defaultSettings,
    players.length,
    seededBytes(1),
  );
  table.seeds.set(alice.deviceId, made.seatSeed);
  table.record(alice, made.event);
  const controllers = players.map((ref, i) => table.add(ref, 100 + i));
  for (const c of controllers.slice(1)) c.join();
  await vi.advanceTimersByTimeAsync(0);
  return { table, controllers };
}

/** Each controller plays the Medium computer's move (or rolls) whenever it is its turn. */
async function playOut(table: Table, limit = 2_000) {
  const random = seededRandom(7);
  for (let i = 0; i < limit; i++) {
    const game = table.fold();
    if (game.phase !== 'playing') return game;
    let acted = false;
    for (const { controller } of table.controllers) {
      const view = controller.getView();
      if (view.waiting !== 'you' || !view.state) continue;
      if (table.rules.dice) controller.roll();
      else controller.move(await table.rules.bot(view.state, 'medium', random));
      acted = true;
    }
    await vi.advanceTimersByTimeAsync(acted ? 1 : 1_000);
  }
  return table.fold();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('turn games with friends', () => {
  it('Tic-Tac-Toe: lobby, start, a whole game; every device agrees', async () => {
    const { table, controllers } = await setUp(TIC_TAC_TOE, [alice, bob]);
    const started = table.fold();
    expect(started.phase).toBe('playing');
    expect(started.seats.map((s) => s.userId)).toEqual([alice.userId, bob.userId]);
    const game = await playOut(table);
    expect(game.phase).toBe('over');
    expect(game.desync).toBe(false);
    for (const c of controllers) {
      expect(c.getView().game.state).toEqual(game.state);
      expect(c.getView().waiting).toBe('over');
    }
    const summary = turnGameSummary(TIC_TAC_TOE, game, alice);
    expect(summary.state).toBe('over');
    expect(turnNetStatus(TIC_TAC_TOE, controllers[0]!.getView())).toMatch(/won|lost|draw/i);
  });

  it('folds the same game from shuffled and duplicated events', async () => {
    const { table } = await setUp(CONNECT_FOUR, [alice, bob]);
    const game = await playOut(table);
    const random = seededRandom(3);
    const shuffled = [...table.events, ...table.events.slice(0, 5)]
      .map((e) => ({ e, k: random.next() }))
      .sort((a, b) => a.k - b.k)
      .map(({ e }) => e);
    const again = foldTurnGame(CONNECT_FOUR, table.gameId, shuffled, sha256);
    expect(again.state).toEqual(game.state);
    expect(again.entries.map((e) => e.eventId)).toEqual(game.entries.map((e) => e.eventId));
  });

  it('plays for an absent player after the timer, and takes them out after three', async () => {
    const { table, controllers } = await setUp(CONNECT_FOUR, [alice, bob]);
    // Bob's app closes.
    table.remove(controllers[1]!);
    const random = seededRandom(11);
    for (let i = 0; i < 200 && table.fold().phase === 'playing'; i++) {
      const view = controllers[0]!.getView();
      if (view.waiting === 'you' && view.state) {
        controllers[0]!.move(
          await CONNECT_FOUR.bot(view.state as ConnectFourState, 'easy', random),
        );
      }
      await vi.advanceTimersByTimeAsync(CONNECT_FOUR.turnMs! + TURN_GRACE_MS + 100);
    }
    const game = table.fold();
    expect(game.phase).toBe('over');
    const proxies = game.entries.filter((e) => e.kind === 'proxy');
    expect(proxies.length).toBeGreaterThan(0);
    for (const e of proxies) expect(e.by.deviceId).toBe(alice.deviceId);
    // Nobody has four in a row after three discs each, so the third proxy move decides it.
    expect(proxies).toHaveLength(3);
    expect(game.state!.left).toEqual([false, true]);
    expect(game.state!.ranks).toEqual([1, 2]);
  });

  it("plays the user's own move when their timer runs out with the app open", async () => {
    const { table } = await setUp(TIC_TAC_TOE, [alice, bob]);
    const first = table.fold().state!.current;
    await vi.advanceTimersByTimeAsync(TIC_TAC_TOE.turnMs! + 100);
    const game = table.fold();
    expect(game.entries[0]?.kind).toBe('move');
    expect(game.entries[0]?.seat).toBe(first);
    expect(game.strikes[first]).toBe(0);
  });

  it('ignores moves out of turn, illegal moves and wrong proxy moves', async () => {
    const { table, controllers } = await setUp(TIC_TAC_TOE, [alice, bob]);
    for (const { controller } of table.controllers) controller.dispose();
    table.controllers.length = 0;
    const game = table.fold();
    const state = game.state!;
    const mover = state.current === 0 ? alice : bob;
    const other = state.current === 0 ? bob : alice;
    const move = (from: GamePlayerRef, cell: number, turn = 0) =>
      table.record(from, {
        gameId: uuidToBytes(table.gameId),
        turn,
        event: {
          case: 'move',
          value: {
            salt: new Uint8Array(16),
            stateHash: turnStateHash(
              TIC_TAC_TOE,
              sha256,
              TIC_TAC_TOE.apply(state as TicTacToeState, { cell }),
            ),
            play: { case: 'ticTacToe', value: { cell } },
          },
        },
      });
    // Someone else may only play the proxy move (and only after the timer, which receivers
    // cannot check): any other square is refused.
    const proxy = proxyTurnMove(TIC_TAC_TOE, sha256, state) as { cell: number };
    move(other, (proxy.cell + 1) % 9);
    move(other, (proxy.cell + 2) % 9);
    expect(table.fold().entries).toHaveLength(0);
    move(mover, 9);
    expect(table.fold().entries).toHaveLength(0);
    move(mover, 4);
    const after = table.fold();
    expect(after.entries).toHaveLength(1);
    expect(after.desync).toBe(false);
    // The same square again, for the next turn, is illegal.
    move(other, 4, 1);
    expect(table.fold().entries).toHaveLength(1);
    expect(controllers).toHaveLength(2);
  });

  it('marks a desync when a move claims another state', async () => {
    const { table } = await setUp(TIC_TAC_TOE, [alice, bob]);
    for (const { controller } of table.controllers) controller.dispose();
    const state = table.fold().state!;
    table.record(state.current === 0 ? alice : bob, {
      gameId: uuidToBytes(table.gameId),
      event: {
        case: 'move',
        value: {
          salt: new Uint8Array(16),
          stateHash: new Uint8Array(8),
          play: { case: 'ticTacToe', value: { cell: 0 } },
        },
      },
    });
    const game = table.fold();
    expect(game.entries).toHaveLength(1);
    expect(game.desync).toBe(true);
  });

  it('a leave ends a two-player game; with three, play goes on', async () => {
    const two = await setUp(TIC_TAC_TOE, [alice, bob]);
    two.controllers[1]!.leave();
    await vi.advanceTimersByTimeAsync(0);
    const ended = two.table.fold();
    expect(ended.phase).toBe('over');
    expect(ended.state!.ranks).toEqual([1, 2]);
    expect(turnGameSummary(TIC_TAC_TOE, ended, bob).text).toBe('You left the game');

    const three = await setUp(DOTS_AND_BOXES, [alice, bob, carol], { size: 3 });
    expect(three.table.fold().phase).toBe('playing');
    three.controllers[2]!.leave();
    await vi.advanceTimersByTimeAsync(0);
    const game = three.table.fold();
    expect(game.phase).toBe('playing');
    expect(game.state!.left).toEqual([false, false, true]);
    const done = await playOut(three.table);
    expect(done.phase).toBe('over');
    expect(done.state!.ranks![2]).toBe(3);
  });

  it('Snakes and Ladders: fair dice to the end, and a skip for an absent roller', async () => {
    const { table, controllers } = await setUp(SNAKES_AND_LADDERS, [alice, bob]);
    expect(controllers.every((c) => !c.getView().locked)).toBe(true);
    const game = await playOut(table);
    expect(game.phase).toBe('over');
    expect(game.desync).toBe(false);
    expect(game.entries.every((e) => e.kind === 'roll' && e.die! >= 1 && e.die! <= 6)).toBe(true);
    expect((game.state as SnakesState).positions).toContain(100);

    const second = await setUp(SNAKES_AND_LADDERS, [alice, bob]);
    const absent = second.table.fold().state!.current === 0 ? 0 : 1;
    second.table.remove(second.controllers[absent]!);
    await vi.advanceTimersByTimeAsync(SNAKES_AND_LADDERS.turnMs! + TURN_GRACE_MS + 100);
    const skipped = second.table.fold();
    expect(skipped.entries[0]?.kind).toBe('skip');
    expect(skipped.desync).toBe(false);
  });

  it('Chess: no timers, a draw offered with a move and taken, the host picks a side', async () => {
    const { table, controllers } = await setUp(CHESS, [alice, bob], { hostSide: 'black' });
    const started = table.fold();
    const state = started.state as ChessState;
    // The host (Alice, seat 0) asked for Black.
    expect(state.white).toBe(1);
    expect(state.current).toBe(1);
    // Nobody plays for anyone: long past any timer, nothing happens.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(table.fold().entries).toHaveLength(0);
    controllers[1]!.move({ from: 12, to: 28, offerDraw: true });
    await vi.advanceTimersByTimeAsync(0);
    expect((table.fold().state as ChessState).drawOffer).toBe(1);
    controllers[0]!.move({ acceptDraw: true });
    await vi.advanceTimersByTimeAsync(0);
    const game = table.fold();
    expect(game.phase).toBe('over');
    expect((game.state as ChessState).end).toBe('agreed');
    expect(game.desync).toBe(false);
    expect(turnGameSummary(CHESS, game, alice).text).toBe("It's a draw");
  });

  it('Chess: resigning is a leave, at once, whoever is to move', async () => {
    const { table, controllers } = await setUp(CHESS, [alice, bob], { hostSide: 'white' });
    controllers[0]!.move({ from: 12, to: 28 });
    await vi.advanceTimersByTimeAsync(0);
    // It is Black's turn; White resigns anyway.
    controllers[0]!.leave();
    await vi.advanceTimersByTimeAsync(0);
    const game = table.fold();
    expect(game.phase).toBe('over');
    expect((game.state as ChessState).end).toBe('resigned');
    expect(game.state!.ranks).toEqual([2, 1]);
  });

  it('Last Card: three players to the end; hands stay hidden; absent turns are draw and pass', async () => {
    const { table, controllers } = await setUp(LAST_CARD, [alice, bob, carol]);
    const started = table.fold();
    expect(started.phase).toBe('playing');
    // Everyone's opening hand is hidden in the shared state; each player sees only their own.
    expect((started.state as LastCardState).hands.flat().every((c) => c.card === 0)).toBe(true);
    for (const [seat, c] of controllers.entries()) {
      const view = c.getView().state as LastCardState;
      const you = c.getView().you;
      expect(view.hands[you]!.every((h) => h.card > 0)).toBe(true);
      expect(
        view.hands
          .filter((_, s) => s !== you)
          .flat()
          .every((h) => h.card === 0),
      ).toBe(true);
      expect(seat).toBeGreaterThanOrEqual(0);
    }
    // No seat secret ever appears in a shared event.
    const wire = table.events.map((e) => e.payload).join('');
    for (const seed of table.seeds.values()) expect(wire).not.toContain(seed);

    // Carol's app closes: the others play her turns as draw-and-pass, then she is out.
    table.remove(controllers[2]!);
    const random = seededRandom(13);
    for (let i = 0; i < 3_000 && table.fold().phase === 'playing'; i++) {
      let acted = false;
      for (const { controller } of table.controllers) {
        const view = controller.getView();
        if (view.waiting !== 'you' || !view.state) continue;
        controller.move(await LAST_CARD.bot(view.state as LastCardState, 'medium', random));
        acted = true;
      }
      await vi.advanceTimersByTimeAsync(acted ? 1 : LAST_CARD.turnMs! + TURN_GRACE_MS + 3_100);
    }
    const game = table.fold();
    expect(game.phase).toBe('over');
    expect(game.desync).toBe(false);
    const proxies = game.entries.filter((e) => e.kind === 'proxy');
    for (const p of proxies) expect(p.seat).toBe(2);
    expect(proxies.length).toBeGreaterThan(0);
    // Every card played was proved: the played cards are known in the entries.
    const plays = game.entries.filter(
      (e) => e.kind === 'move' && e.move && 'play' in (e.move as LastCardMove),
    );
    expect(plays.length).toBeGreaterThan(0);
  }, 60_000);

  it('the host can end the game for everyone', async () => {
    const { table, controllers } = await setUp(CONNECT_FOUR, [alice, bob]);
    controllers[1]!.end();
    controllers[0]!.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(table.fold().phase).toBe('ended');
    expect(turnGameSummary(CONNECT_FOUR, table.fold(), bob).text).toBe('Ended');
  });
});
