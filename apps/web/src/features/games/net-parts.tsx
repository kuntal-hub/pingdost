// Pieces every game-with-friends page shares in the browser (Phases 42–43): the lobby, quick
// emotes, the out-of-sync notice, the chat button with its unread count, toasts for new messages
// in the game's chat, Rematch, and the "Back to game" pill the chat shows while a game you play
// there is still going.
import { MessageCircle, Play, RotateCcw, TriangleAlert, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { create } from 'zustand';

import { useConversations, useNames } from '@/chat/hooks';
import { useChatClient } from '@/chat/store';
import { Button, IconButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { previewText } from '@pingdost/chat-core';
import type { LobbyEntry, NetEmote, TurnGameId } from '@pingdost/games';
import { quickReactions } from '@pingdost/ui-tokens';

import { gameIconFor } from './game-icons';
import { startGame, useGameSummary } from './network';

/** Emotes stay on screen this long. */
const EMOTE_MS = 30_000;
/** A new-message toast stays this long. */
const TOAST_MS = 4_000;

/** What the shared pieces need from a game's view (Ludo's and the turn games' both fit). */
export interface NetViewLike {
  game: {
    phase: string;
    lobby: readonly LobbyEntry[];
    maxPlayers: number;
    emotes: readonly NetEmote[];
    desync: boolean;
  };
  canJoin: boolean;
  canStart: boolean;
  isHost: boolean;
}

export function NetLobby({
  view,
  type,
  selfUserId,
  nameOf,
  status,
  onJoin,
  onStart,
}: {
  view: NetViewLike;
  type: string;
  selfUserId: string;
  nameOf: (userId: string) => string;
  status: string;
  onJoin: () => void;
  onStart: () => void;
}) {
  const { game } = view;
  if (game.phase === 'invalid') {
    return (
      <EmptyState icon={TriangleAlert} title="This game can't be played">
        <p className="text-muted">Start a new one from the chat.</p>
      </EmptyState>
    );
  }
  const Icon = gameIconFor(type);
  const joined = game.lobby.some((e) => e.userId === selfUserId);
  const full = game.lobby.length >= game.maxPlayers;
  return (
    <div className="pd-card flex w-full max-w-md flex-col gap-4 rounded-2xl p-5">
      <p aria-live="polite" className="text-center font-bold">
        {status}
      </p>
      <ul className="flex flex-col gap-2">
        {Array.from({ length: game.maxPlayers }, (_, i) => {
          const entry = game.lobby[i];
          return (
            <li key={entry?.userId ?? `seat-${i}`} className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-accent/15 text-accent">
                {entry ? <Icon aria-hidden size={18} /> : <UserPlus aria-hidden size={18} />}
              </span>
              <span className={entry ? 'font-bold' : 'text-muted'}>
                {entry ? nameOf(entry.userId) : 'Open seat'}
                {entry && i === 0 ? ' (host)' : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {view.canJoin && (
        <Button onClick={onJoin}>
          <UserPlus aria-hidden size={18} />
          Join
        </Button>
      )}
      {view.canStart && (
        <Button onClick={onStart} variant={full ? 'primary' : 'secondary'}>
          <Play aria-hidden size={18} />
          Start with {game.lobby.length} players
        </Button>
      )}
      {joined && !view.isHost && !view.canJoin && (
        <p className="text-center text-sm text-muted">
          The game starts when the host starts it or the table is full.
        </p>
      )}
    </div>
  );
}

export function DesyncNotice({ view }: { view: NetViewLike }) {
  if (!view.game.desync) return null;
  return (
    <p
      role="alert"
      className="flex w-full items-center gap-2 rounded-xl bg-surface px-3 py-2 text-sm"
    >
      <TriangleAlert aria-hidden size={18} className="shrink-0 text-danger" />
      This game is out of sync between the players.
      {view.isHost ? ' You can end it from the menu.' : ''}
    </p>
  );
}

export function NetEmotes({
  view,
  now,
  nameOf,
  onEmote,
}: {
  view: NetViewLike;
  now: number;
  nameOf: (userId: string) => string;
  onEmote: (emoji: string) => void;
}) {
  const recent = view.game.emotes.filter((e) => now - e.receivedAt < EMOTE_MS).slice(-4);
  const canSend = view.game.phase === 'lobby' || view.game.phase === 'playing';
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-2">
      {recent.length > 0 && (
        <ul aria-live="polite" className="flex flex-wrap justify-center gap-2">
          {recent.map((e) => (
            <li key={e.eventId} className="pd-rise rounded-full bg-surface px-3 py-1 text-sm">
              <span className="font-bold">{nameOf(e.userId)}</span> {e.emoji}
            </li>
          ))}
        </ul>
      )}
      {canSend && (
        <div role="group" aria-label="Send a reaction" className="flex gap-1">
          {quickReactions.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Send ${emoji}`}
              onClick={() => onEmote(emoji)}
              className="pd-press size-10 cursor-pointer rounded-full text-xl hover:bg-surface"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useChatEntry(conversationId: string | undefined) {
  const { entries } = useConversations();
  return conversationId
    ? entries.find((e) => e.conversation.conversationId === conversationId)
    : undefined;
}

/** Back to the game's chat; a badge counts its unread messages. */
export function ChatButton({
  conversationId,
  onOpen,
}: {
  conversationId: string | undefined;
  onOpen: () => void;
}) {
  const unread = useChatEntry(conversationId)?.conversation.unreadCount ?? 0;
  return (
    <span className="relative">
      <IconButton
        aria-label={unread > 0 ? `Back to the chat, ${unread} unread` : 'Back to the chat'}
        onClick={onOpen}
      >
        <MessageCircle aria-hidden size={20} />
      </IconButton>
      {unread > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-on-primary"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </span>
  );
}

/** A toast for each new message in the game's chat while the game is on screen. */
export function MessageToasts({
  conversationId,
  onOpen,
}: {
  conversationId: string | undefined;
  onOpen: () => void;
}) {
  const names = useNames();
  const last = useChatEntry(conversationId)?.last;
  const seen = useRef<string | null | undefined>(undefined);
  const [toast, setToast] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (seen.current === undefined) {
      // Whatever is there when the game opens is old news.
      seen.current = last?.messageId ?? null;
      return;
    }
    if (!last || last.messageId === seen.current) return;
    seen.current = last.messageId;
    if (last.direction !== 'in' || last.kind === 'game' || last.kind === 'system') return;
    const who = names.name(last.senderUserId);
    setToast({ id: last.messageId, text: `${who}: ${previewText(last, names)}` });
  }, [last, names]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <button
      key={toast.id}
      type="button"
      aria-live="polite"
      onClick={() => {
        setToast(null);
        onOpen();
      }}
      className="pd-floating pd-rise fixed left-1/2 top-4 z-50 flex max-w-[min(92vw,420px)] -translate-x-1/2 cursor-pointer items-center gap-2 rounded-2xl px-4 py-3 text-left text-sm"
    >
      <MessageCircle aria-hidden size={18} className="shrink-0 text-accent" />
      <span className="line-clamp-2">{toast.text}</span>
      <span className="sr-only">Open the chat</span>
    </button>
  );
}

export interface ActiveGame {
  gameId: string;
  conversationId: string;
}

/**
 * The last game with friends opened in this tab: its chat shows a "Back to game" pill while the
 * game is still going (the game page itself is gone once the chat opens).
 */
export const useActiveGame = create<{ game: ActiveGame | null }>(() => ({ game: null }));

export function useMarkActiveGame(game: ActiveGame | null): void {
  useEffect(() => {
    if (!game) return;
    const current = useActiveGame.getState().game;
    if (current?.gameId !== game.gameId) useActiveGame.setState({ game });
  }, [game?.gameId, game?.conversationId]);
}

/** In a chat: back to the game with friends opened last, while it is still going. */
export function BackToGamePill({ conversationId }: { conversationId: string }) {
  const names = useNames();
  const game = useActiveGame((state) =>
    state.game?.conversationId === conversationId ? state.game : null,
  );
  const summary = useGameSummary(game?.gameId ?? '', (id) =>
    id === names.selfUserId ? 'You' : names.name(id),
  );
  if (!game || !summary?.live || !summary.playing) return null;
  const yours = summary.state === 'your-turn';
  return (
    <Link
      to={`/games/play/${game.gameId}`}
      className={`pd-floating pd-rise absolute left-1/2 top-[78px] z-10 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm font-bold ${
        yours ? 'bg-primary text-on-primary' : ''
      }`}
    >
      <Play aria-hidden size={16} />
      Back to the game{yours ? ' · your turn' : ''}
    </Link>
  );
}

/** A new game in the same chat with the same table and rules; opens it. */
export function RematchButton({
  conversationId,
  type,
  settings,
  maxPlayers,
}: {
  conversationId: string | undefined;
  type: 'ludo' | TurnGameId;
  settings: unknown;
  maxPlayers: number;
}) {
  const client = useChatClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      disabled={!client || !conversationId || busy}
      onClick={() => {
        if (!client || !conversationId) return;
        setBusy(true);
        void startGame(client, conversationId, type, settings, maxPlayers)
          .then((gameId) => navigate(`/games/play/${gameId}`, { replace: true }))
          .catch(() => setBusy(false));
      }}
    >
      <RotateCcw aria-hidden size={18} />
      Rematch
    </Button>
  );
}
