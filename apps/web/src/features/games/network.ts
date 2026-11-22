// Games with friends in the browser (Phases 42–43, ADR 0049): hooks over the chat client. Each
// game's events are folded in this tab (`@pingdost/games`); the leader tab's engine stores and
// sends them. A seat's secret is kept with the game in this browser's sealed store.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useChatClient } from '@/chat/store';
import { cryptoProvider } from '@/crypto/provider';
import { useSession } from '@/session/session';
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
  type GamePlayerRef,
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

type ChatClient = NonNullable<ReturnType<typeof useChatClient>>;

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

/** Starts a game in a chat (an invitation card); returns its ID. */
export async function startGame(
  client: ChatClient,
  conversationId: string,
  type: 'ludo' | TurnGameId,
  settings: unknown,
  maxPlayers: number,
): Promise<string> {
  const provider = await cryptoProvider();
  const sha256: Sha256 = (d) => provider.sha256(d);
  const { event, seatSeed } =
    type === 'ludo'
      ? createLudoEvent(sha256, settings as LudoSettings, maxPlayers)
      : createTurnEvent(turnRules(type), sha256, settings, maxPlayers);
  const sent = await client.sendGameEvent(conversationId, event, { seatSeed });
  return sent.gameId;
}

/** Starts a Ludo game in a chat; returns its ID. */
export function startLudoGame(
  client: ChatClient,
  conversationId: string,
  settings: LudoSettings,
  maxPlayers: number,
): Promise<string> {
  return startGame(client, conversationId, 'ludo', settings, maxPlayers);
}

export interface GameEntry {
  record: GameRecord;
  folded: AnyNetGame | null;
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
            const folded = foldAnyGame(
              record.gameType,
              record.gameId,
              await client.listGameEvents(record.gameId),
              sha256,
            );
            return { record, folded, summary: anyGameSummary(folded, self, names) };
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

/** One game folded and summed up, kept current (its chat card, the game page's choice). */
export function useGameEntry(gameId: string, names?: NameOf): GameEntry | null {
  const client = useChatClient();
  const sha256 = useSha256();
  const self = useSelf();
  const [entry, setEntry] = useState<{ record: GameRecord; folded: AnyNetGame | null } | null>(
    null,
  );
  useEffect(() => {
    if (!client || !sha256) return;
    let live = true;
    const load = async () => {
      try {
        const [record, events] = await Promise.all([
          client.getGame(gameId),
          client.listGameEvents(gameId),
        ]);
        if (live && record) {
          setEntry({ record, folded: foldAnyGame(record.gameType, gameId, events, sha256) });
        }
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
  if (!entry || !self) return null;
  return { ...entry, summary: anyGameSummary(entry.folded, self, names) };
}

/** One game's line for its card in the chat. */
export function useGameSummary(gameId: string, names?: NameOf): GameSummary | null {
  return useGameEntry(gameId, names)?.summary ?? null;
}

/** The game's record (type, chat), kept current; undefined while loading, null if unknown. */
export function useGameRecord(gameId: string): GameRecord | null | undefined {
  const client = useChatClient();
  const [record, setRecord] = useState<GameRecord | null | undefined>(undefined);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const load = async () => {
      try {
        const found = await client.getGame(gameId);
        if (live) setRecord(found ?? null);
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
  }, [client, gameId]);
  return record;
}

interface NetController {
  update(events: readonly GameEventLike[], seatSeed?: string | null): void;
  dispose(): void;
}

/**
 * A controller for a game with friends, created in an effect (so a discarded render never
 * starts timers) and kept current by the game's events.
 */
function useNetController<C extends NetController>(
  gameId: string,
  make: (args: {
    client: ChatClient;
    sha256: Sha256;
    self: GamePlayerRef;
    record: GameRecord;
    events: GameEventLike[];
  }) => C,
): { controller: C | null; record: GameRecord | null } {
  const client = useChatClient();
  const sha256 = useSha256();
  const device = useSession((state) => state.device);
  const [controller, setController] = useState<C | null>(null);
  const [record, setRecord] = useState<GameRecord | null>(null);
  const makeRef = useRef(make);
  makeRef.current = make;
  const userId = device?.userId;
  const deviceId = device?.deviceId;

  useEffect(() => {
    if (!client || !sha256 || !userId || !deviceId) return;
    let live = true;
    let created: C | null = null;
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
          created = makeRef.current({
            client,
            sha256,
            self: { userId, deviceId },
            record: stored,
            events,
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
  }, [client, sha256, userId, deviceId, gameId]);
  return { controller, record };
}

function useView<V>(
  controller: { subscribe(listener: () => void): () => void; getView(): V } | null,
): V | null {
  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  return useSyncExternalStore(subscribe, () => controller?.getView() ?? null);
}

/** A Ludo game with friends for its page. */
export function useLudoNetGame(
  gameId: string,
  pace: LudoPace,
  autoMove: boolean,
): { controller: LudoNetController | null; view: LudoNetView | null; record: GameRecord | null } {
  const paceRef = useRef(pace);
  paceRef.current = pace;
  const autoRef = useRef(autoMove);
  autoRef.current = autoMove;
  const { controller, record } = useNetController(
    gameId,
    ({ client, sha256, self, record: stored, events }) =>
      new LudoNetController({
        gameId,
        events,
        seatSeed: stored.seatSeed,
        pace: paceRef.current,
        autoMove: autoRef.current,
        port: {
          self,
          sha256,
          send: (event, options) => client.sendGameEvent(stored.conversationId, event, options),
        },
      }),
  );
  useEffect(() => controller?.setPace(pace), [controller, pace]);
  useEffect(() => controller?.setAutoMove(autoMove), [controller, autoMove]);
  return { controller, view: useView(controller), record };
}

export type AnyTurnNetController = TurnNetController<TurnCore, unknown, unknown>;
export type AnyTurnNetView = TurnNetView<TurnCore, unknown, unknown>;

/** A turn game with friends (Phase 43) for its page. */
export function useTurnNetGame(
  gameId: string,
  rules: AnyTurnRules,
  pace: TurnPace,
): {
  controller: AnyTurnNetController | null;
  view: AnyTurnNetView | null;
  record: GameRecord | null;
} {
  const paceRef = useRef(pace);
  paceRef.current = pace;
  const { controller, record } = useNetController(
    gameId,
    ({ client, sha256, self, record: stored, events }) =>
      new TurnNetController({
        rules,
        gameId,
        events,
        seatSeed: stored.seatSeed,
        pace: paceRef.current,
        port: {
          self,
          sha256,
          send: (event, options) => client.sendGameEvent(stored.conversationId, event, options),
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
