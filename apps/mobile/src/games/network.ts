// Games with friends on the phone (Phase 42, ADR 0049): hooks over the chat engine, the same
// shape as the web's (`apps/web/src/features/games/network.ts`). Each game's events are folded
// here (`@pingdost/games`); the engine stores and sends them, and keeps this device's seat
// secret with the game in the encrypted database.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { getCryptoContext } from '@/crypto/bootstrap';
import { useChatRuntime } from '@/engine/hooks';
import type { ChatRuntime } from '@/engine/runtime';
import {
  createLudoEvent,
  foldLudoGame,
  ludoGameSummary,
  LudoNetController,
  type GameSummary,
  type LudoNetGame,
  type LudoNetView,
  type LudoPace,
  type LudoSettings,
  type NameOf,
  type Sha256,
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

/** Starts a Ludo game in a chat; returns its ID. */
export async function startLudoGame(
  runtime: ChatRuntime,
  conversationId: string,
  settings: LudoSettings,
  maxPlayers: number,
): Promise<string> {
  const { provider } = await getCryptoContext();
  const { event, seatSeed } = createLudoEvent((d) => provider.sha256(d), settings, maxPlayers);
  const sent = await runtime.engine.sendGameEvent(conversationId, event, { seatSeed });
  return sent.gameId;
}

export interface GameEntry {
  record: GameRecord;
  game: LudoNetGame;
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
          const game = foldLudoGame(
            record.gameId,
            await runtime.engine.listGameEvents(record.gameId),
            sha256,
          );
          return { record, game, summary: ludoGameSummary(game, self, names) };
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

/** One game's line for its card in the chat. */
export function useGameSummary(gameId: string, names?: NameOf): GameSummary | null {
  const runtime = useChatRuntime();
  const sha256 = useSha256();
  const [game, setGame] = useState<LudoNetGame | null>(null);
  useEffect(() => {
    if (!runtime || !sha256) return;
    let live = true;
    const load = async () => {
      const folded = foldLudoGame(gameId, await runtime.engine.listGameEvents(gameId), sha256);
      if (live) setGame(folded);
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
  if (!game || !runtime) return null;
  return ludoGameSummary(game, { userId: runtime.userId, deviceId: runtime.deviceId }, names);
}

/**
 * A game with friends for its screen: the controller (created in an effect, so a discarded
 * render never starts timers), kept current by the game's events.
 */
export function useLudoNetGame(
  gameId: string,
  pace: LudoPace,
  autoMove: boolean,
): { controller: LudoNetController | null; view: LudoNetView | null; record: GameRecord | null } {
  const runtime = useChatRuntime();
  const sha256 = useSha256();
  const [controller, setController] = useState<LudoNetController | null>(null);
  const [record, setRecord] = useState<GameRecord | null>(null);
  const latestPace = useLatest(pace);
  const latestAutoMove = useLatest(autoMove);

  useEffect(() => {
    if (!runtime || !sha256) return;
    let live = true;
    let created: LudoNetController | null = null;
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
          created = new LudoNetController({
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
          });
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
  useEffect(() => controller?.setPace(pace), [controller, pace]);
  useEffect(() => controller?.setAutoMove(autoMove), [controller, autoMove]);

  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  const view = useSyncExternalStore(subscribe, () => controller?.getView() ?? null);
  return { controller, view, record };
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
