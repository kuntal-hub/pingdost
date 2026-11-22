// A game invitation in a chat (Phases 42–43, ADR 0049): which game, how it stands, and a button
// to join, play or watch. Its line updates as the game's events arrive.
import { router } from 'expo-router';
import { View } from 'react-native';

import { DicesIcon, GAME_ICONS, Icon } from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { useGameSummary } from '@/games/network';
import type { Names } from '@pingdost/chat-core';
import { catalogEntry, gameTypeLabel, isPlayableGameType } from '@pingdost/games';
import { readGameCard, type MessageRecord } from '@pingdost/message-engine';

export function GameCard({
  message,
  names,
  outgoing,
}: {
  message: MessageRecord;
  names: Names;
  outgoing: boolean;
}) {
  const card = readGameCard(message.body);
  const summary = useGameSummary(card?.gameId ?? message.messageId, (id) =>
    id === names.selfUserId ? 'You' : names.name(id),
  );
  if (!card) return null;
  const title = gameTypeLabel(card.type);
  const icon = isPlayableGameType(card.type) ? GAME_ICONS[catalogEntry(card.type).icon] : DicesIcon;
  const action =
    summary?.state === 'invite'
      ? 'Join'
      : summary?.live && summary.playing
        ? summary.state === 'your-turn'
          ? 'Play'
          : 'Open'
        : summary?.live
          ? 'Watch'
          : 'View';
  const open = () =>
    router.push({
      pathname: '/game/[gameId]',
      params: { gameId: card.gameId, ...(summary?.state === 'invite' ? { join: '1' } : {}) },
    });
  return (
    <View className="min-w-[220px] flex-row items-center gap-3 py-1">
      <View
        className={`h-11 w-11 items-center justify-center rounded-xl ${
          outgoing ? 'bg-on-primary/15' : 'bg-raised'
        }`}
      >
        <Icon icon={icon} size={24} color={outgoing ? 'on-primary' : 'accent'} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className={`text-base font-bold ${outgoing ? 'text-on-primary' : 'text-foreground'}`}>
          {title}
        </Text>
        <Text
          numberOfLines={1}
          className={`text-sm ${outgoing ? 'text-on-primary opacity-85' : 'text-muted'}`}
        >
          {summary?.text ?? 'Loading…'}
        </Text>
      </View>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`${action} ${title}`}
        feedback="light"
        onPress={open}
        className={`rounded-full px-4 py-2 ${outgoing ? 'bg-on-primary' : 'bg-primary'}`}
      >
        <Text className={`text-sm font-bold ${outgoing ? 'text-primary' : 'text-on-primary'}`}>
          {action}
        </Text>
      </Tap>
    </View>
  );
}
