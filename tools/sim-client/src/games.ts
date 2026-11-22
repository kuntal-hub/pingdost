/**
 * Games for a sim client (Phases 42–43, ADR 0049): one controller per game it can see, fed by
 * the engine's game events — `LudoNetController` for Ludo, `TurnNetController` for the turn
 * games. With `autoJoin` it joins every invitation; on its own turn it rolls or plays the Medium
 * computer's move after `thinkMs`. Tests and `peer` use it.
 */
import type { CryptoProvider } from '@pingdost/crypto';
import {
  chooseLudoToken,
  createLudoEvent,
  createTurnEvent,
  DEFAULT_LUDO_SETTINGS,
  FAST_PACE,
  FAST_TURN_PACE,
  isTurnGameId,
  LudoNetController,
  seededRandom,
  turnRules,
  TurnNetController,
  type LudoNetView,
  type LudoPace,
  type LudoSettings,
  type TurnCore,
  type TurnGameId,
  type TurnNetView,
  type TurnPace,
} from '@pingdost/games';

import type { SimClient } from './client';

export interface SimGamesOptions {
  /** Join every game it is invited to (default true). */
  autoJoin?: boolean;
  /** Play its own turns (default true); off, its app's timers play for it. */
  play?: boolean;
  /** Pause before its own roll or move, in ms (default 300). */
  thinkMs?: number;
  /** How long each Ludo step is shown (default the fast pace; zeros for tests). */
  pace?: LudoPace;
  /** How long each step of the other games is shown (default the fast pace). */
  turnPace?: TurnPace;
  log?: (line: string) => void;
}

type TurnView = TurnNetView<TurnCore, unknown, unknown>;
type AnyTurnController = TurnNetController<TurnCore, unknown, unknown>;

export interface SimGames {
  /** Starts a Ludo game in the chat; returns its ID. */
  createLudo(
    conversationId: string,
    options?: { maxPlayers?: number; settings?: LudoSettings },
  ): Promise<string>;
  /** Starts a turn game (Tic-Tac-Toe, Connect Four, …) in the chat; returns its ID. */
  createTurn(
    conversationId: string,
    type: TurnGameId,
    options?: { maxPlayers?: number; settings?: unknown },
  ): Promise<string>;
  view(gameId: string): LudoNetView | undefined;
  controller(gameId: string): LudoNetController | undefined;
  turnView(gameId: string): TurnView | undefined;
  turnController(gameId: string): AnyTurnController | undefined;
  /** Resolves when `check` holds for the Ludo game's view. */
  until(
    gameId: string,
    check: (view: LudoNetView) => boolean,
    timeoutMs?: number,
  ): Promise<LudoNetView>;
  /** Resolves when `check` holds for the turn game's view. */
  untilTurn(
    gameId: string,
    check: (view: TurnView) => boolean,
    timeoutMs?: number,
  ): Promise<TurnView>;
  stop(): void;
}

type Entry =
  | { kind: 'ludo'; controller: LudoNetController; conversationId: string }
  | { kind: 'turn'; controller: AnyTurnController; conversationId: string };

export function simGames(
  client: SimClient,
  crypto: CryptoProvider,
  options: SimGamesOptions = {},
): SimGames {
  const think = options.thinkMs ?? 300;
  const log = options.log ?? (() => undefined);
  const entries = new Map<string, Entry>();
  const random = seededRandom(Date.now() >>> 0);
  const sha256 = (data: Uint8Array) => crypto.sha256(data);
  let stopped = false;

  const port = (conversationId: string) => ({
    self: { userId: client.userId, deviceId: client.deviceId },
    sha256,
    send: (
      event: Parameters<typeof client.engine.sendGameEvent>[1],
      sendOptions?: { seatSeed?: string },
    ) => client.engine.sendGameEvent(conversationId, event, sendOptions),
  });

  function watchLudo(gameId: string, controller: LudoNetController): void {
    let lastPhase = '';
    let acting = '';
    controller.subscribe(() => {
      const view = controller.getView();
      if (view.game.phase !== lastPhase) {
        lastPhase = view.game.phase;
        log(`game ${gameId.slice(-6)}: ${lastPhase}`);
      }
      if (options.autoJoin !== false && view.canJoin) controller.join();
      const board = view.board;
      if (options.play === false || !board) return;
      const slot = `${view.game.turn}:${view.game.index}:${board.waiting}`;
      if (acting === slot) return;
      if (board.waiting === 'you-roll') {
        acting = slot;
        setTimeout(() => controller.roll(), think);
      } else if (board.waiting === 'you-move') {
        acting = slot;
        const token = chooseLudoToken(board.state, 'medium', random);
        setTimeout(() => controller.move(token), think);
      }
    });
  }

  function watchTurn(gameId: string, controller: AnyTurnController): void {
    let lastPhase = '';
    let acting = -1;
    const rules = controller.rules;
    controller.subscribe(() => {
      const view = controller.getView();
      if (view.game.phase !== lastPhase) {
        lastPhase = view.game.phase;
        log(`${rules.id} ${gameId.slice(-6)}: ${lastPhase}`);
      }
      if (options.autoJoin !== false && view.canJoin) controller.join();
      const state = view.state;
      if (options.play === false || !state || view.waiting !== 'you') return;
      if (acting === state.turns) return;
      acting = state.turns;
      setTimeout(() => {
        if (rules.dice) {
          controller.roll();
          return;
        }
        void Promise.resolve(rules.bot(state, 'medium', random)).then((move) =>
          controller.move(move),
        );
      }, think);
    });
  }

  async function refresh(gameId: string): Promise<void> {
    if (stopped) return;
    const engine = client.engine;
    const [record, events] = await Promise.all([
      engine.getGame(gameId),
      engine.listGameEvents(gameId),
    ]);
    if (!record || stopped) return;
    const existing = entries.get(gameId);
    if (existing) {
      existing.controller.update(events, record.seatSeed);
      return;
    }
    if (record.gameType === 'ludo') {
      const controller = new LudoNetController({
        gameId,
        events,
        seatSeed: record.seatSeed,
        pace: options.pace ?? FAST_PACE,
        autoMove: true,
        port: port(record.conversationId),
      });
      entries.set(gameId, { kind: 'ludo', controller, conversationId: record.conversationId });
      watchLudo(gameId, controller);
      const view = controller.getView();
      if (options.autoJoin !== false && view.canJoin) controller.join();
      return;
    }
    // Before its `create` arrives the type is unknown; the next event tries again.
    if (!isTurnGameId(record.gameType)) return;
    const controller = new TurnNetController({
      rules: turnRules(record.gameType),
      gameId,
      events,
      seatSeed: record.seatSeed,
      pace: options.turnPace ?? FAST_TURN_PACE,
      port: port(record.conversationId),
    });
    entries.set(gameId, { kind: 'turn', controller, conversationId: record.conversationId });
    watchTurn(gameId, controller);
    const view = controller.getView();
    if (options.autoJoin !== false && view.canJoin) controller.join();
  }

  const off = client.engine.onGameEvent((event) => {
    void refresh(event.gameId).catch((error: unknown) =>
      log(`game refresh failed: ${String(error)}`),
    );
  });
  void client.engine.listGames().then((games) => {
    for (const game of games) void refresh(game.gameId);
  });

  const ludoOf = (gameId: string) => {
    const entry = entries.get(gameId);
    return entry?.kind === 'ludo' ? entry.controller : undefined;
  };
  const turnOf = (gameId: string) => {
    const entry = entries.get(gameId);
    return entry?.kind === 'turn' ? entry.controller : undefined;
  };

  async function until<V>(
    gameId: string,
    view: () => V | undefined,
    check: (view: V) => boolean,
    timeoutMs: number,
    phase: () => string,
  ): Promise<V> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = view();
      if (current && check(current)) return current;
      if (Date.now() > deadline) throw new Error(`game ${gameId}: timed out (phase ${phase()})`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return {
    async createLudo(conversationId, createOptions = {}) {
      const { event, seatSeed } = createLudoEvent(
        sha256,
        createOptions.settings ?? DEFAULT_LUDO_SETTINGS,
        createOptions.maxPlayers ?? 2,
      );
      const sent = await client.engine.sendGameEvent(conversationId, event, { seatSeed });
      await refresh(sent.gameId);
      return sent.gameId;
    },
    async createTurn(conversationId, type, createOptions = {}) {
      const rules = turnRules(type);
      const { event, seatSeed } = createTurnEvent(
        rules,
        sha256,
        createOptions.settings ?? rules.defaultSettings,
        createOptions.maxPlayers ?? rules.minPlayers,
      );
      const sent = await client.engine.sendGameEvent(conversationId, event, { seatSeed });
      await refresh(sent.gameId);
      return sent.gameId;
    },
    view: (gameId) => ludoOf(gameId)?.getView(),
    controller: ludoOf,
    turnView: (gameId) => turnOf(gameId)?.getView(),
    turnController: turnOf,
    until: (gameId, check, timeoutMs = 60_000) =>
      until(
        gameId,
        () => ludoOf(gameId)?.getView(),
        check,
        timeoutMs,
        () => ludoOf(gameId)?.getView().game.phase ?? 'none',
      ),
    untilTurn: (gameId, check, timeoutMs = 60_000) =>
      until(
        gameId,
        () => turnOf(gameId)?.getView(),
        check,
        timeoutMs,
        () => turnOf(gameId)?.getView().game.phase ?? 'none',
      ),
    stop() {
      stopped = true;
      off();
      for (const entry of entries.values()) entry.controller.dispose();
      entries.clear();
    },
  };
}
