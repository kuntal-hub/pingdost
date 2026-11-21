/**
 * Games for a sim client (Phase 42, ADR 0049): one `LudoNetController` per game it can see,
 * fed by the engine's game events. With `autoJoin` it joins every invitation; on its own turn
 * it rolls after `thinkMs` and moves the Medium computer's choice. Tests and `peer` use it.
 */
import type { CryptoProvider } from '@pingdost/crypto';
import {
  chooseLudoToken,
  createLudoEvent,
  DEFAULT_LUDO_SETTINGS,
  FAST_PACE,
  LudoNetController,
  seededRandom,
  type LudoNetView,
  type LudoPace,
  type LudoSettings,
} from '@pingdost/games';

import type { SimClient } from './client';

export interface SimGamesOptions {
  /** Join every game it is invited to (default true). */
  autoJoin?: boolean;
  /** Play its own turns (default true); off, its app's timers play for it. */
  play?: boolean;
  /** Pause before its own roll or move, in ms (default 300). */
  thinkMs?: number;
  /** How long each step is shown (default the fast pace; zeros for tests). */
  pace?: LudoPace;
  log?: (line: string) => void;
}

export interface SimGames {
  /** Starts a Ludo game in the chat; returns its ID. */
  createLudo(
    conversationId: string,
    options?: { maxPlayers?: number; settings?: LudoSettings },
  ): Promise<string>;
  view(gameId: string): LudoNetView | undefined;
  controller(gameId: string): LudoNetController | undefined;
  /** Resolves when `check` holds for the game's view. */
  until(
    gameId: string,
    check: (view: LudoNetView) => boolean,
    timeoutMs?: number,
  ): Promise<LudoNetView>;
  stop(): void;
}

export function simGames(
  client: SimClient,
  crypto: CryptoProvider,
  options: SimGamesOptions = {},
): SimGames {
  const think = options.thinkMs ?? 300;
  const log = options.log ?? (() => undefined);
  const controllers = new Map<string, { controller: LudoNetController; conversationId: string }>();
  const random = seededRandom(Date.now() >>> 0);
  const sha256 = (data: Uint8Array) => crypto.sha256(data);
  let stopped = false;

  async function refresh(gameId: string): Promise<void> {
    if (stopped) return;
    const engine = client.engine;
    const [record, events] = await Promise.all([
      engine.getGame(gameId),
      engine.listGameEvents(gameId),
    ]);
    if (!record || stopped) return;
    const existing = controllers.get(gameId);
    if (existing) {
      existing.controller.update(events, record.seatSeed);
      return;
    }
    const controller = new LudoNetController({
      gameId,
      events,
      seatSeed: record.seatSeed,
      pace: options.pace ?? FAST_PACE,
      autoMove: true,
      port: {
        self: { userId: client.userId, deviceId: client.deviceId },
        sha256,
        send: (event, sendOptions) =>
          client.engine.sendGameEvent(record.conversationId, event, sendOptions),
      },
    });
    controllers.set(gameId, { controller, conversationId: record.conversationId });
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
    view: (gameId) => controllers.get(gameId)?.controller.getView(),
    controller: (gameId) => controllers.get(gameId)?.controller,
    async until(gameId, check, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const view = controllers.get(gameId)?.controller.getView();
        if (view && check(view)) return view;
        if (Date.now() > deadline) {
          throw new Error(`game ${gameId}: timed out (phase ${view?.game.phase ?? 'none'})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    stop() {
      stopped = true;
      off();
      for (const { controller } of controllers.values()) controller.dispose();
      controllers.clear();
    },
  };
}
