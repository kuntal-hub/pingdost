// Games with friends on the Games tab (Phase 42, ADR 0049): games waiting for you, games in
// play, invitations, and friends online to invite (circle members who share their presence).
// Inviting opens the 1:1 chat's game setup; the game itself lives in that chat.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { DicesIcon, GAME_ICONS, Icon, SendIcon } from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { useCircle } from '@/engine/circle';
import { useGroup, useNames } from '@/engine/groups';
import { useChatRuntime, useConversations } from '@/engine/hooks';
import { useChatStore, watchPresence } from '@/engine/runtime';
import { useGameList, type GameEntry } from '@/games/network';
import { useTheme } from '@/theme/theme-root';
import { catalogEntry, gameTypeLabel, isPlayableGameType } from '@pingdost/games';
import type { ConversationRecord } from '@pingdost/message-engine';

function GameRow({
  entry,
  conversation,
}: {
  entry: GameEntry;
  conversation: ConversationRecord | undefined;
}) {
  const { card } = useTheme();
  const names = useNames();
  const group = useGroup(conversation?.kind === 'group' ? conversation.conversationId : undefined);
  const chat =
    group?.name ?? (conversation?.peerUserId ? names.name(conversation.peerUserId) : 'Chat');
  const { summary } = entry;
  const type = entry.record.gameType;
  const title = gameTypeLabel(type);
  const icon = isPlayableGameType(type) ? GAME_ICONS[catalogEntry(type).icon] : DicesIcon;
  const yours = summary.state === 'your-turn';
  const action =
    summary.state === 'invite' ? 'Join' : yours ? 'Play' : summary.live ? 'Open' : 'View';
  const open = () =>
    router.push({
      pathname: '/game/[gameId]',
      params: {
        gameId: entry.record.gameId,
        ...(summary.state === 'invite' ? { join: '1' } : {}),
      },
    });
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${chat}, ${summary.text}. ${action}`}
      onPress={open}
      className="flex-row items-center gap-3 rounded-2xl bg-surface p-3"
      style={card}
    >
      <View
        className={`h-11 w-11 items-center justify-center rounded-xl ${yours ? 'bg-primary' : 'bg-raised'}`}
      >
        <Icon icon={icon} size={24} color={yours ? 'on-primary' : 'accent'} />
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-bold text-foreground">
          {title} · {chat}
        </Text>
        <Text numberOfLines={1} className="text-sm text-muted">
          {summary.text}
        </Text>
      </View>
      <Text className={`text-sm font-bold ${yours ? 'text-accent' : 'text-muted'}`}>{action}</Text>
    </Tap>
  );
}

export function FriendGames() {
  const names = useNames();
  const games = useGameList((id) => (id === names.selfUserId ? 'You' : names.name(id)));
  const { entries } = useConversations();
  const conversations = useMemo(
    () => new Map(entries.map((e) => [e.conversation.conversationId, e.conversation])),
    [entries],
  );
  const sections: [string, GameEntry[]][] = [
    ['Your turn', games.filter((g) => g.summary.state === 'your-turn')],
    [
      'Playing',
      games.filter((g) => g.summary.live && g.summary.playing && g.summary.state !== 'your-turn'),
    ],
    ['Invitations', games.filter((g) => g.summary.state === 'invite')],
  ];
  return (
    <>
      {sections
        .filter(([, list]) => list.length > 0)
        .map(([title, list]) => (
          <View key={title} className="gap-2 px-5">
            <Text accessibilityRole="header" className="px-1 font-bold text-muted">
              {title}
            </Text>
            {list.map((entry) => (
              <GameRow
                key={entry.record.gameId}
                entry={entry}
                conversation={conversations.get(entry.record.conversationId)}
              />
            ))}
          </View>
        ))}
    </>
  );
}

export function FriendsOnline() {
  const { card } = useTheme();
  const runtime = useChatRuntime();
  const names = useNames();
  const members = useCircle((state) => state.members);
  const presence = useChatStore((state) => state.presence);
  const ids = members.map((m) => m.userId).join(',');

  // Watched while the Games tab is in front, beside the open chat's peer.
  useFocusEffect(
    useCallback(() => {
      if (ids === '') return;
      watchPresence(ids.split(','), 'games');
      return () => watchPresence([], 'games');
    }, [ids]),
  );

  if (members.length === 0) return null;
  const online = members.filter((m) => presence[m.userId]);

  async function invite(userId: string) {
    if (!runtime) return;
    const { conversationId } = await runtime.engine.openDirectConversation(userId);
    router.push({ pathname: '/game/start', params: { conversationId } });
  }

  return (
    <View className="gap-2 px-5">
      <Text accessibilityRole="header" className="px-1 font-bold text-muted">
        Friends online
      </Text>
      {online.length === 0 ? (
        <Text className="px-1 text-sm text-muted">
          Nobody in your circle is online right now (only friends who share when they are online
          show here). You can still start a game from any chat.
        </Text>
      ) : (
        online.map((member) => (
          <View
            key={member.userId}
            className="flex-row items-center gap-3 rounded-2xl bg-surface p-3"
            style={card}
          >
            <Avatar url={null} name={names.name(member.userId)} size={40} online />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-base font-bold text-foreground">
              {names.name(member.userId)}
            </Text>
            <Button
              label="Invite"
              icon={SendIcon}
              variant="secondary"
              onPress={() => void invite(member.userId)}
            />
          </View>
        ))
      )}
    </View>
  );
}
