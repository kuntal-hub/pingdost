// Games with friends on the phone (Phases 42–43, ADR 0049): hooks over the chat engine, the same
// shape as the web's (`apps/web/src/features/games/network.ts`). Each game's events are folded
// here (`@pingdost/games`); the engine stores and sends them, and keeps this device's seat
// secret with the game in the encrypted database.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { getCryptoContext } from '@/crypto/bootstrap';
import { useChatRuntime } from '@/engine/hooks';
import type { ChatRuntime } from '@/engine/runtime';
import {
  anyGameSummary,
  createLudoEvent,
  createTurnEvent,
  foldAnyGame,
  isTurnGameId,
  LudoNetController,
  turnRules,
  TurnNetController,
  type AnyNetGame,
  type AnyTurnRules,
  type GameEventLike,
  type GameSummary,
  type LudoNetView,
  type LudoPace,
  type LudoSettings,
  type NameOf,
  type Sha256,
  type TurnCore,
  type TurnGameId,
  type TurnNetView,
  type TurnPace,
} from '@pingdost/games';
import type { GameRecord } from '@pingdost/message-engine';

let hasher: Sha256 | undefined;

/** SHA-256 from the native crypto provider (ready once the app has started). */
export function useSha256(): Sha256 | undefined {
  const [sha256, setSha256] = useState(() => hasher);
  useEffect(() => {
    if (sha256) return;
    let live = true;
    void getCryptoContext().then(({ provider }) => {
      hasher = (data) => provider.sha256(data);
      if (live) setSha256(() => hasher);
    });
    return () => {
      live = false;
    };
  }, [sha256]);
  return sha256;
}

/** Starts a game in a chat (an invitation card); returns its ID. */
export async function startGame(
  runtime: ChatRuntime,
  conversationId: string,
  type: 'ludo' | TurnGameId,
  settings: unknown,
  maxPlayers: number,
): Promise<string> {
  const { provider } = await getCryptoContext();
  const sha256: Sha256 = (d) => provider.sha256(d);
  const { event, seatSeed } =
    type === 'ludo'
      ? createLudoEvent(sha256, settings as LudoSettings, maxPlayers)
      : createTurnEvent(turnRules(type), sha256, settings, maxPlayers);
  const sent = await runtime.engine.sendGameEvent(conversationId, event, { seatSeed });
  return sent.gameId;
}

/** Starts a Ludo game in a chat; returns its ID. */
export function startLudoGame(
  runtime: ChatRuntime,
  conversationId: string,
  settings: LudoSettings,
  maxPlayers: number,
): Promise<string> {
  return startGame(runtime, conversationId, 'ludo', settings, maxPlayers);
}

export interface GameEntry {
  record: GameRecord;
  folded: AnyNetGame | null;
  summary: GameSummary;
}

/** Every game on this phone, newest activity first, folded (the Games tab). */
export function useGameList(names?: NameOf): GameEntry[] {
  const runtime = useChatRuntime();
  const sha256 = useSha256();
  const [entries, setEntries] = useState<GameEntry[]>([]);
  useEffect(() => {
    if (!runtime || !sha256) return;
    const self = { userId: runtime.userId, deviceId: runtime.deviceId };
    let live = true;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const records = await runtime.engine.listGames();
      const next = await Promise.all(
        records.map(async (record) => {
          const folded = foldAnyGame(
            record.gameType,
            record.gameId,
            await runtime.engine.listGameEvents(record.gameId),
            sha256,
          );
          return { record, folded, summary: anyGameSummary(folded, self, names) };
        }),
      );
      if (live) setEntries(next);
    };
    void load();
    // A burst of events (a turn's roll and move) loads once.
    const off = runtime.engine.onGameEvent(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void load();
      }, 150);
    });
    return () => {
      live = false;
      off();
      if (pending) clearTimeout(pending);
    };
    // `names` changes identity on every render; the list reloads on each event anyway.
  }, [runtime, sha256]);
  return entries;
}

/** One game folded, kept current: its card in the chat, the game route's choice of screen. */
export function useGameEntry(gameId: string, names?: NameOf): GameEntry | null {
  const runtime = useChatRuntime();
  const sha256 = useSha256();
  const [entry, setEntry] = useState<{ record: GameRecord; folded: AnyNetGame | null } | null>(
    null,
  );
  useEffect(() => {
    if (!runtime || !sha256) return;
    let live = true;
    const load = async () => {
      const [record, events] = await Promise.all([
        runtime.engine.getGame(gameId),
        runtime.engine.listGameEvents(gameId),
      ]);
      if (!live || !record) return;
      setEntry({ record, folded: foldAnyGame(record.gameType, gameId, events, sha256) });
    };
    void load();
    const off = runtime.engine.onGameEvent((event) => {
      if (event.gameId === gameId) void load();
    });
    return () => {
      live = false;
      off();
    };
  }, [runtime, sha256, gameId]);
  if (!entry || !runtime) return null;
  const self = { userId: runtime.userId, deviceId: runtime.deviceId };
  return { ...entry, summary: anyGameSummary(entry.folded, self, names) };
}

/** One game's line for its card in the chat. */
export function useGameSummary(gameId: string, names?: NameOf): GameSummary | null {
  return useGameEntry(gameId, names)?.summary ?? null;
}

/** The game's record (type, chat), kept current, for routing to its screen. */
export function useGameRecord(gameId: string): GameRecord | null | undefined {
  const runtime = useChatRuntime();
  const [record, setRecord] = useState<GameRecord | null | undefined>(undefined);
  useEffect(() => {
    if (!runtime) return;
    let live = true;
    const load = async () => {
      const found = await runtime.engine.getGame(gameId);
      if (live) setRecord(found ?? null);
    };
    void load();
    const off = runtime.engine.onGameEvent((event) => {
      if (event.gameId === gameId) void load();
    });
    return () => {
      live = false;
      off();
    };
  }, [runtime, gameId]);
  return record;
}

/**
 * A controller for a game with friends, created in an effect (so a discarded render never
 * starts timers) and kept current by the game's events.
 */
interface NetController {
  update(events: readonly GameEventLike[], seatSeed?: string | null): void;
  dispose(): void;
}

function useNetController<C extends NetController>(
  gameId: string,
  make: (args: {
    runtime: ChatRuntime;
    sha256: Sha256;
    record: GameRecord;
    events: Awaited<ReturnType<ChatRuntime['engine']['listGameEvents']>>;
  }) => C,
): { controller: C | null; record: GameRecord | null } {
  const runtime = useChatRuntime();
  const sha256 = useSha256();
  const [controller, setController] = useState<C | null>(null);
  const [record, setRecord] = useState<GameRecord | null>(null);
  const latestMake = useLatest(make);

  useEffect(() => {
    if (!runtime || !sha256) return;
    let live = true;
    let created: C | null = null;
    let reloads = Promise.resolve();
    const reload = () => {
      reloads = reloads
        .then(async () => {
          const [stored, events] = await Promise.all([
            runtime.engine.getGame(gameId),
            runtime.engine.listGameEvents(gameId),
          ]);
          if (!live || !stored) return;
          setRecord(stored);
          if (created) {
            created.update(events, stored.seatSeed);
            return;
          }
          created = latestMake.current({ runtime, sha256, record: stored, events });
          setController(created);
        })
        .catch(() => undefined);
    };
    reload();
    const off = runtime.engine.onGameEvent((event) => {
      if (event.gameId === gameId) reload();
    });
    return () => {
      live = false;
      off();
      created?.dispose();
      setController(null);
    };
  }, [runtime, sha256, gameId]);
  return { controller, record };
}

function useView<V>(
  controller: {
    subscribe(listener: () => void): () => void;
    getView(): V;
  } | null,
): V | null {
  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  return useSyncExternalStore(subscribe, () => controller?.getView() ?? null);
}

/** A Ludo game with friends for its screen. */
export function useLudoNetGame(
  gameId: string,
  pace: LudoPace,
  autoMove: boolean,
): { controller: LudoNetController | null; view: LudoNetView | null; record: GameRecord | null } {
  const latestPace = useLatest(pace);
  const latestAutoMove = useLatest(autoMove);
  const { controller, record } = useNetController(
    gameId,
    ({ runtime, sha256, record: stored, events }) =>
      new LudoNetController({
        gameId,
        events,
        seatSeed: stored.seatSeed,
        pace: latestPace.current,
        autoMove: latestAutoMove.current,
        port: {
          self: { userId: runtime.userId, deviceId: runtime.deviceId },
          sha256,
          send: (event, options) =>
            runtime.engine.sendGameEvent(stored.conversationId, event, options),
        },
      }),
  );
  useEffect(() => controller?.setPace(pace), [controller, pace]);
  useEffect(() => controller?.setAutoMove(autoMove), [controller, autoMove]);
  return { controller, view: useView(controller), record };
}

export type AnyTurnNetController = TurnNetController<TurnCore, unknown, unknown>;
export type AnyTurnNetView = TurnNetView<TurnCore, unknown, unknown>;

/** A turn game with friends (Phase 43) for its screen. */
export function useTurnNetGame(
  gameId: string,
  rules: AnyTurnRules,
  pace: TurnPace,
): {
  controller: AnyTurnNetController | null;
  view: AnyTurnNetView | null;
  record: GameRecord | null;
} {
  const latestPace = useLatest(pace);
  const { controller, record } = useNetController(
    gameId,
    ({ runtime, sha256, record: stored, events }) =>
      new TurnNetController({
        rules,
        gameId,
        events,
        seatSeed: stored.seatSeed,
        pace: latestPace.current,
        port: {
          self: { userId: runtime.userId, deviceId: runtime.deviceId },
          sha256,
          send: (event, options) =>
            runtime.engine.sendGameEvent(stored.conversationId, event, options),
        },
      }),
  );
  useEffect(() => controller?.setPace(pace), [controller, pace]);
  return { controller, view: useView(controller), record };
}

/** The rules of a turn game type, or null for Ludo and unknown types. */
export function turnRulesOf(type: string | undefined): AnyTurnRules | null {
  return type && isTurnGameId(type) ? turnRules(type) : null;
}

function useLatest<T>(value: T): { current: T } {
  const [box] = useState(() => ({ current: value }));
  box.current = value;
  return box;
}

/** Ticks every `ms` while `on`, for timer rings and emotes. */
export function useNow(on: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
  return now;
}
