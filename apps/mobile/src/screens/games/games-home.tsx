// The Games tab (Phase 41, ADR 0049): games with friends (your turn, playing, invitations),
// friends online to invite, the catalog, an unfinished solo game and the results kept on this
// phone. Games with friends live in their chat (Phase 42).
import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/button';
import { useTabBarInset } from '@/components/floating-tab-bar';
import { GAME_ICONS, Icon, PlayIcon } from '@/components/icon';
import { TabHeader } from '@/components/screen';
import { Text } from '@/components/text';
import { useGames } from '@/games/store';
import { useTheme } from '@/theme/theme-root';
import {
  BOT_LEVEL_NAMES,
  BOT_LEVELS,
  GAME_CATALOG,
  LUDO_COLOR_NAMES,
  totals,
  type CatalogEntry,
} from '@pingdost/games';

import { FriendGames, FriendsOnline } from './friend-games';

function players(entry: CatalogEntry): string {
  return entry.minPlayers === entry.maxPlayers
    ? `${entry.minPlayers} players`
    : `${entry.minPlayers}–${entry.maxPlayers} players`;
}

function ContinueCard() {
  const { card } = useTheme();
  const solo = useGames((state) => state.solo);
  if (!solo || solo.state.phase === 'over') return null;
  const { options, state } = solo;
  const yourTurn = state.players[state.current]?.color === options.you;
  return (
    <View className="mx-5 gap-3 rounded-2xl bg-surface p-4" style={card}>
      <View className="flex-row items-center gap-3">
        <View className="h-12 w-12 items-center justify-center rounded-xl bg-raised">
          <Icon icon={GAME_ICONS.dice} size={26} color="accent" />
        </View>
        <View className="flex-1">
          <Text className="text-base font-bold text-foreground">Ludo in progress</Text>
          <Text className="text-sm text-muted">
            You ({LUDO_COLOR_NAMES[options.you]}) against {options.computers}{' '}
            {options.computers === 1 ? 'computer player' : 'computer players'} ·{' '}
            {BOT_LEVEL_NAMES[options.level]}
            {yourTurn ? ' · your turn' : ''}
          </Text>
        </View>
      </View>
      <Button label="Continue" icon={PlayIcon} onPress={() => router.push('/game/ludo')} />
    </View>
  );
}

function GameCard({ entry }: { entry: CatalogEntry }) {
  const { card } = useTheme();
  return (
    <View className="mx-5 gap-3 rounded-2xl bg-surface p-4" style={card}>
      <View className="flex-row items-center gap-3">
        <View className="h-14 w-14 items-center justify-center rounded-xl bg-raised">
          <Icon icon={GAME_ICONS[entry.icon]} size={30} color="accent" />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="font-display text-xl text-foreground">{entry.name}</Text>
          <Text className="text-sm text-muted">{entry.tagline}</Text>
          <Text className="text-xs text-muted">{players(entry)}</Text>
        </View>
      </View>
      <Button
        label="Play with the computer"
        onPress={() => router.push('/game/ludo-setup')}
        feedback="selection"
      />
      <Text className="text-center text-xs text-muted">
        To play with friends, start a game from a chat, or invite a friend below.
      </Text>
    </View>
  );
}

function ComingSoon() {
  const soon = GAME_CATALOG.filter((entry) => !entry.available);
  return (
    <View className="gap-2 px-5">
      <Text accessibilityRole="header" className="px-1 font-bold text-muted">
        Coming soon
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {soon.map((entry) => (
          <View
            key={entry.id}
            accessibilityLabel={`${entry.name}, coming soon`}
            className="w-[31%] items-center gap-1 rounded-xl bg-raised px-2 py-3"
          >
            <Icon icon={GAME_ICONS[entry.icon]} size={24} color="muted" />
            <Text numberOfLines={1} className="text-xs font-semibold text-muted">
              {entry.name}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Record() {
  const { card } = useTheme();
  const stats = useGames((state) => state.stats.ludo);
  const all = totals(stats);
  if (all.played === 0) return null;
  return (
    <View className="gap-2 px-5">
      <Text accessibilityRole="header" className="px-1 font-bold text-muted">
        Your Ludo record
      </Text>
      <View className="flex-row gap-2">
        {BOT_LEVELS.map((level) => {
          const tally = stats?.solo[level] ?? { played: 0, won: 0 };
          return (
            <View
              key={level}
              accessibilityLabel={`${BOT_LEVEL_NAMES[level]}: won ${tally.won} of ${tally.played}`}
              className="flex-1 items-center gap-0.5 rounded-xl bg-surface py-3"
              style={card}
            >
              <Text className="text-xl font-bold text-foreground">
                {tally.won}/{tally.played}
              </Text>
              <Text className="text-xs text-muted">{BOT_LEVEL_NAMES[level]}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function GamesHomeScreen() {
  const tabInset = useTabBarInset();
  useFocusEffect(
    useCallback(() => {
      void useGames.getState().load();
    }, []),
  );
  const available = GAME_CATALOG.filter((entry) => entry.available);
  return (
    <View className="flex-1 bg-background">
      <TabHeader title="Games" />
      <ScrollView contentContainerStyle={{ paddingBottom: tabInset, paddingTop: 8, gap: 20 }}>
        <FriendGames />
        <ContinueCard />
        {available.map((entry) => (
          <GameCard key={entry.id} entry={entry} />
        ))}
        <FriendsOnline />
        <Record />
        <ComingSoon />
        <Text className="px-6 text-xs text-muted">
          Games against the computer run only on this phone, and your results stay here. PingDost
          keeps no record of the games you play.
        </Text>
      </ScrollView>
    </View>
  );
}
