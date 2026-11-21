// Games with friends in the browser (Phase 42, ADR 0049): hooks over the chat client. Each
// game's events are folded in this tab (`@pingdost/games`); the leader tab's engine stores and
// sends them. A seat's secret is kept with the game in this browser's sealed store.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { useChatClient } from '@/chat/store';
import { cryptoProvider } from '@/crypto/provider';
import { useSession } from '@/session/session';
import {
  createLudoEvent,
  foldLudoGame,
  ludoGameSummary,
  LudoNetController,
  type GamePlayerRef,
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

/** SHA-256 from the crypto module (loaded once). */
export function useSha256(): Sha256 | undefined {
  const [sha256, setSha256] = useState(() => hasher);
  useEffect(() => {
    if (sha256) return;
    let live = true;
    void cryptoProvider().then((provider) => {
      hasher = (data) => provider.sha256(data);
      if (live) setSha256(() => hasher);
    });
    return () => {
      live = false;
    };
  }, [sha256]);
  return sha256;
}

export function useSelf(): GamePlayerRef | undefined {
  const device = useSession((state) => state.device);
  return device ? { userId: device.userId, deviceId: device.deviceId } : undefined;
}

/** Starts a Ludo game in a chat; returns its ID. */
export async function startLudoGame(
  client: NonNullable<ReturnType<typeof useChatClient>>,
  conversationId: string,
  settings: LudoSettings,
  maxPlayers: number,
): Promise<string> {
  const provider = await cryptoProvider();
  const { event, seatSeed } = createLudoEvent((d) => provider.sha256(d), settings, maxPlayers);
  const sent = await client.sendGameEvent(conversationId, event, { seatSeed });
  return sent.gameId;
}

export interface GameEntry {
  record: GameRecord;
  game: LudoNetGame;
  summary: GameSummary;
}

/** Every game this browser knows, newest activity first, folded (the Games page). */
export function useGameList(names?: NameOf): GameEntry[] {
  const client = useChatClient();
  const sha256 = useSha256();
  const self = useSelf();
  const [entries, setEntries] = useState<GameEntry[]>([]);
  const selfKey = self ? `${self.userId}/${self.deviceId}` : '';
  useEffect(() => {
    if (!client || !sha256 || !self) return;
    let live = true;
    const load = async () => {
      try {
        const records = await client.listGames();
        const next = await Promise.all(
          records.map(async (record) => {
            const game = foldLudoGame(
              record.gameId,
              await client.listGameEvents(record.gameId),
              sha256,
            );
            return { record, game, summary: ludoGameSummary(game, self, names) };
          }),
        );
        if (live) setEntries(next);
      } catch {
        // The leader is changing: the next event loads again.
      }
    };
    void load();
    const off = client.onGameEvent(() => void load());
    return () => {
      live = false;
      off();
    };
    // `self` is compared by its key; `names` changes identity every render.
  }, [client, sha256, selfKey]);
  return entries;
}

/** One game's line for its card in the chat. */
export function useGameSummary(gameId: string, names?: NameOf): GameSummary | null {
  const client = useChatClient();
  const sha256 = useSha256();
  const self = useSelf();
  const [game, setGame] = useState<LudoNetGame | null>(null);
  useEffect(() => {
    if (!client || !sha256) return;
    let live = true;
    const load = async () => {
      try {
        const folded = foldLudoGame(gameId, await client.listGameEvents(gameId), sha256);
        if (live) setGame(folded);
      } catch {
        // Loads again on the next event.
      }
    };
    void load();
    const off = client.onGameEvent((event) => {
      if (event.gameId === gameId) void load();
    });
    return () => {
      live = false;
      off();
    };
  }, [client, sha256, gameId]);
  return game && self ? ludoGameSummary(game, self, names) : null;
}

/**
 * A game with friends for its page: the controller (created in an effect, so a discarded
 * render never starts timers), kept current by the game's events.
 */
export function useLudoNetGame(
  gameId: string,
  pace: LudoPace,
  autoMove: boolean,
): { controller: LudoNetController | null; view: LudoNetView | null; record: GameRecord | null } {
  const client = useChatClient();
  const sha256 = useSha256();
  const device = useSession((state) => state.device);
  const [controller, setController] = useState<LudoNetController | null>(null);
  const [record, setRecord] = useState<GameRecord | null>(null);
  const userId = device?.userId;
  const deviceId = device?.deviceId;

  useEffect(() => {
    if (!client || !sha256 || !userId || !deviceId) return;
    let live = true;
    let created: LudoNetController | null = null;
    let reloads = Promise.resolve();
    const reload = () => {
      reloads = reloads
        .then(async () => {
          const [stored, events] = await Promise.all([
            client.getGame(gameId),
            client.listGameEvents(gameId),
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
            pace,
            autoMove,
            port: {
              self: { userId, deviceId },
              sha256,
              send: (event, options) => client.sendGameEvent(stored.conversationId, event, options),
            },
          });
          setController(created);
        })
        .catch(() => undefined);
    };
    reload();
    const off = client.onGameEvent((event) => {
      if (event.gameId === gameId) reload();
    });
    return () => {
      live = false;
      off();
      created?.dispose();
      setController(null);
    };
    // Pace and auto-move are applied below without a new controller.
  }, [client, sha256, userId, deviceId, gameId]);
  useEffect(() => controller?.setPace(pace), [controller, pace]);
  useEffect(() => controller?.setAutoMove(autoMove), [controller, autoMove]);

  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  const view = useSyncExternalStore(subscribe, () => controller?.getView() ?? null);
  return { controller, view, record };
}

/** Ticks every `ms` while `on`, for timer rings. */
export function useNow(on: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
  return now;
}
