// Pieces every game-with-friends screen shares (Phases 42–43): the lobby, quick emotes, the
// out-of-sync notice, the chat button with its unread count, toasts for new messages in the
// game's chat, Rematch, and the "Back to game" pill the chat shows while the game is open.
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Button } from '@/components/button';
import { EmptyState } from '@/components/feedback';
import {
  GAME_ICONS,
  Icon,
  MessageCircleIcon,
  PlayIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  UserPlusIcon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { useChatData } from '@/engine/chat-store';
import { useNames } from '@/engine/groups';
import { useChatRuntime, useConversationRecord } from '@/engine/hooks';
import { clearActiveGame, setActiveGame, useActiveGame, type ActiveGame } from '@/games/active';
import { startGame } from '@/games/network';
import { CSS_POP, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import { previewText } from '@pingdost/chat-core';
import {
  catalogEntry,
  type GameId,
  type LobbyEntry,
  type NetEmote,
  type TurnGameId,
} from '@pingdost/games';
import { quickReactions } from '@pingdost/ui-tokens';

/** Emotes stay on screen this long. */
const EMOTE_MS = 30_000;
/** A new-message toast stays this long. */
const TOAST_MS = 4_000;

const DOWN_IN = {
  from: { opacity: 0, transform: [{ translateY: -16 }] },
  to: { opacity: 1, transform: [{ translateY: 0 }] },
};

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
  game: gameType,
  selfUserId,
  nameOf,
  status,
  onJoin,
  onStart,
}: {
  view: NetViewLike;
  game: GameId;
  selfUserId: string;
  nameOf: (userId: string) => string;
  status: string;
  onJoin: () => void;
  onStart: () => void;
}) {
  const { card } = useTheme();
  const { game } = view;
  if (game.phase === 'invalid') {
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        title="This game can't be played"
        message="Start a new one from the chat."
      />
    );
  }
  const joined = game.lobby.some((e) => e.userId === selfUserId);
  const full = game.lobby.length >= game.maxPlayers;
  const icon = GAME_ICONS[catalogEntry(gameType).icon];
  return (
    <View className="flex-1 justify-center px-4">
      <View className="gap-4 rounded-2xl bg-surface p-5" style={card}>
        <Text
          accessibilityLiveRegion="polite"
          className="text-center text-base font-bold text-foreground"
        >
          {status}
        </Text>
        <View className="gap-2">
          {Array.from({ length: game.maxPlayers }, (_, i) => {
            const entry = game.lobby[i];
            return (
              <View key={entry?.userId ?? `seat-${i}`} className="flex-row items-center gap-3">
                <View className="h-9 w-9 items-center justify-center rounded-full bg-raised">
                  <Icon icon={entry ? icon : UserPlusIcon} size={18} color="accent" />
                </View>
                <Text className={`text-base ${entry ? 'font-bold text-foreground' : 'text-muted'}`}>
                  {entry ? nameOf(entry.userId) : 'Open seat'}
                  {entry && i === 0 ? ' (host)' : ''}
                </Text>
              </View>
            );
          })}
        </View>
        {view.canJoin && (
          <Button label="Join" icon={UserPlusIcon} feedback="medium" onPress={onJoin} />
        )}
        {view.canStart && (
          <Button
            label={`Start with ${game.lobby.length} players`}
            icon={PlayIcon}
            variant={full ? 'primary' : 'secondary'}
            onPress={onStart}
          />
        )}
        {joined && !view.isHost && (
          <Text className="text-center text-sm text-muted">
            The game starts when the host starts it or the table is full.
          </Text>
        )}
      </View>
    </View>
  );
}

export function DesyncNotice({ view }: { view: NetViewLike }) {
  if (!view.game.desync) return null;
  return (
    <View className="mx-3 mt-2 flex-row items-center gap-2 rounded-xl bg-surface px-3 py-2">
      <Icon icon={TriangleAlertIcon} size={18} color="danger" />
      <Text className="flex-1 text-sm text-foreground">
        This game is out of sync between the players.
        {view.isHost ? ' You can end it from the menu.' : ''}
      </Text>
    </View>
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
  const recent = view.game.emotes.filter((e) => now - e.receivedAt < EMOTE_MS).slice(-3);
  const canSend = view.game.phase === 'lobby' || view.game.phase === 'playing';
  return (
    <View className="items-center gap-2 px-3 pb-4">
      {recent.length > 0 && (
        <View accessibilityLiveRegion="polite" className="flex-row flex-wrap justify-center gap-2">
          {recent.map((e) => (
            <View key={e.eventId} className="rounded-full bg-surface px-3 py-1">
              <Text className="text-sm text-foreground">
                <Text className="font-bold">{nameOf(e.userId)}</Text> {e.emoji}
              </Text>
            </View>
          ))}
        </View>
      )}
      {canSend && (
        <View accessibilityLabel="Send a reaction" className="flex-row gap-1">
          {quickReactions.map((emoji) => (
            <Tap
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={`Send ${emoji}`}
              feedback="light"
              onPress={() => onEmote(emoji)}
              className="h-11 w-11 items-center justify-center rounded-full"
            >
              <Text className="text-xl">{emoji}</Text>
            </Tap>
          ))}
        </View>
      )}
    </View>
  );
}

/** Opens the game's chat; a badge counts its unread messages. */
export function ChatButton({
  conversationId,
  onPress,
}: {
  conversationId: string | undefined;
  onPress: () => void;
}) {
  const unread = useConversationRecord(conversationId ?? '')?.unreadCount ?? 0;
  return (
    <View>
      <IconButton
        icon={MessageCircleIcon}
        label={unread > 0 ? `Open the chat, ${unread} unread` : 'Open the chat'}
        onPress={onPress}
      />
      {unread > 0 && (
        <View
          pointerEvents="none"
          className="absolute right-0.5 top-0.5 h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1"
        >
          <Text className="text-[11px] font-bold text-on-primary">
            {unread > 99 ? '99+' : unread}
          </Text>
        </View>
      )}
    </View>
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
  const { floating } = useTheme();
  const { moves } = useMotion();
  const names = useNames();
  const last = useChatData((state) =>
    conversationId
      ? state.entries.find((e) => e.conversation.conversationId === conversationId)?.last
      : undefined,
  );
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
    const who = last.senderUserId ? names.name(last.senderUserId) : '';
    setToast({ id: last.messageId, text: `${who ? `${who}: ` : ''}${previewText(last, names)}` });
  }, [last, names]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <Animated.View
      key={toast.id}
      pointerEvents="box-none"
      className="absolute left-3 right-3 top-2"
      style={[
        { zIndex: 50 },
        moves
          ? { animationName: DOWN_IN, animationDuration: 220, animationTimingFunction: CSS_POP }
          : {},
      ]}
    >
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`New message. ${toast.text}. Open the chat`}
        accessibilityLiveRegion="polite"
        onPress={() => {
          setToast(null);
          onOpen();
        }}
        className="flex-row items-center gap-2 rounded-2xl bg-surface px-4 py-3"
        style={floating}
      >
        <Icon icon={MessageCircleIcon} size={18} color="accent" />
        <Text numberOfLines={2} className="flex-1 text-sm text-foreground">
          {toast.text}
        </Text>
      </Tap>
    </Animated.View>
  );
}

/** Marks this game as the open one while its screen is mounted (for the chat's pill). */
export function useMarkActiveGame(game: ActiveGame | null): void {
  const id = game?.gameId;
  useEffect(() => {
    if (game) setActiveGame(game);
  }, [game?.gameId, game?.conversationId, game?.yourTurn, game?.name]);
  useEffect(() => {
    if (!id) return;
    return () => clearActiveGame(id);
  }, [id]);
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
  const runtime = useChatRuntime();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label="Rematch"
      icon={RotateCcwIcon}
      feedback="medium"
      disabled={!runtime || !conversationId || busy}
      onPress={() => {
        if (!runtime || !conversationId) return;
        setBusy(true);
        void startGame(runtime, conversationId, type, settings, maxPlayers)
          .then((gameId) => router.replace({ pathname: '/game/[gameId]', params: { gameId } }))
          .catch(() => setBusy(false));
      }}
    />
  );
}

/** In a chat: back to the game with friends whose screen is open under it. */
export function BackToGamePill({ conversationId }: { conversationId: string }) {
  const { palette, floating } = useTheme();
  const game = useActiveGame((state) =>
    state.game?.conversationId === conversationId ? state.game : null,
  );
  if (!game) return null;
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`Back to ${game.name}${game.yourTurn ? ', your turn' : ''}`}
      feedback="selection"
      onPress={() =>
        router.dismissTo({ pathname: '/game/[gameId]', params: { gameId: game.gameId } })
      }
      className="h-[40px] flex-row items-center gap-2 self-center rounded-full px-4"
      style={{
        ...floating,
        backgroundColor: game.yourTurn ? palette.primary : palette.surface,
      }}
    >
      <Icon icon={PlayIcon} size={16} color={game.yourTurn ? 'on-primary' : 'accent'} />
      <Text className={`font-bold ${game.yourTurn ? 'text-on-primary' : 'text-foreground'}`}>
        Back to {game.name}
        {game.yourTurn ? ' · your turn' : ''}
      </Text>
    </Tap>
  );
}
