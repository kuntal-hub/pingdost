// The Games tab (Phases 41–43, ADR 0049): games with friends (your turn, playing, invitations),
// unfinished solo games, the games to play, friends online to invite, the results kept on this
// phone, and what is coming. Games with friends live in their chat.
import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/button';
import { useTabBarInset } from '@/components/floating-tab-bar';
import { GAME_ICONS, Icon, PlayIcon, UsersRoundIcon } from '@/components/icon';
import { TabHeader } from '@/components/screen';
import { Text } from '@/components/text';
import { useGames } from '@/games/store';
import { useTheme } from '@/theme/theme-root';
import {
  BOT_LEVEL_NAMES,
  BOT_LEVELS,
  catalogEntry,
  GAME_CATALOG,
  isTurnGameId,
  LUDO_COLOR_NAMES,
  totals,
  turnRules,
  TURN_GAME_IDS,
  type CatalogEntry,
  type GameId,
} from '@pingdost/games';

import { FriendGames, FriendsOnline } from './friend-games';

function players(entry: CatalogEntry): string {
  return entry.minPlayers === entry.maxPlayers
    ? `${entry.minPlayers} players`
    : `${entry.minPlayers}–${entry.maxPlayers} players`;
}

function ContinueCard({
  game,
  detail,
  onContinue,
}: {
  game: GameId;
  detail: string;
  onContinue: () => void;
}) {
  const { card } = useTheme();
  const entry = catalogEntry(game);
  return (
    <View className="mx-5 gap-3 rounded-2xl bg-surface p-4" style={card}>
      <View className="flex-row items-center gap-3">
        <View className="h-12 w-12 items-center justify-center rounded-xl bg-raised">
          <Icon icon={GAME_ICONS[entry.icon]} size={26} color="accent" />
        </View>
        <View className="flex-1">
          <Text className="text-base font-bold text-foreground">{entry.name} in progress</Text>
          <Text className="text-sm text-muted">{detail}</Text>
        </View>
      </View>
      <Button label="Continue" icon={PlayIcon} onPress={onContinue} />
    </View>
  );
}

function ContinueCards() {
  const solo = useGames((state) => state.solo);
  const turnSolo = useGames((state) => state.turnSolo);
  const cards = [];
  if (solo && solo.state.phase !== 'over') {
    const { options, state } = solo;
    const yourTurn = state.players[state.current]?.color === options.you;
    cards.push(
      <ContinueCard
        key="ludo"
        game="ludo"
        detail={`You (${LUDO_COLOR_NAMES[options.you]}) against ${options.computers} ${
          options.computers === 1 ? 'computer player' : 'computer players'
        } · ${BOT_LEVEL_NAMES[options.level]}${yourTurn ? ' · your turn' : ''}`}
        onContinue={() => router.push('/game/ludo')}
      />,
    );
  }
  for (const id of TURN_GAME_IDS) {
    const game = turnSolo[id];
    if (!game || game.state.ranks) continue;
    const rules = turnRules(id);
    const others = game.options.computers;
    const against = `${others} ${others === 1 ? 'computer player' : 'computer players'}`;
    cards.push(
      <ContinueCard
        key={id}
        game={id}
        detail={`Against ${against}${rules.levels ? ` · ${BOT_LEVEL_NAMES[game.options.level]}` : ''}${
          game.state.current === 0 ? ' · your turn' : ''
        }`}
        onContinue={() => router.push({ pathname: '/game/play', params: { game: id } })}
      />,
    );
  }
  return <>{cards}</>;
}

function GameCard({ entry }: { entry: CatalogEntry }) {
  const { card } = useTheme();
  const solo = () =>
    entry.id === 'ludo'
      ? router.push('/game/ludo-setup')
      : router.push({ pathname: '/game/setup', params: { game: entry.id } });
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
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button label="Computer" icon={PlayIcon} onPress={solo} feedback="selection" />
        </View>
        <View className="flex-1">
          <Button
            label="Friends"
            icon={UsersRoundIcon}
            variant="secondary"
            feedback="selection"
            onPress={() => router.push({ pathname: '/game/pick-chat', params: { game: entry.id } })}
          />
        </View>
      </View>
    </View>
  );
}

function ComingSoon() {
  const soon = GAME_CATALOG.filter((entry) => !entry.available);
  if (soon.length === 0) return null;
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

function Records() {
  const { card } = useTheme();
  const book = useGames((state) => state.stats);
  const played = GAME_CATALOG.filter((entry) => totals(book[entry.id]).played > 0);
  if (played.length === 0) return null;
  return (
    <View className="gap-3 px-5">
      <Text accessibilityRole="header" className="px-1 font-bold text-muted">
        Your record
      </Text>
      {played.map((entry) => {
        const stats = book[entry.id];
        const levels = !isTurnGameId(entry.id) || turnRules(entry.id).levels;
        const tallies = levels
          ? BOT_LEVELS.map((level) => ({
              label: BOT_LEVEL_NAMES[level],
              tally: stats?.solo[level],
            }))
          : [{ label: 'Against the computer', tally: totals(stats) }];
        return (
          <View key={entry.id} className="gap-1">
            <Text className="px-1 text-sm font-semibold text-foreground">{entry.name}</Text>
            <View className="flex-row gap-2">
              {tallies.map(({ label, tally }) => {
                const t = tally ?? { played: 0, won: 0 };
                return (
                  <View
                    key={label}
                    accessibilityLabel={`${entry.name}, ${label}: won ${t.won} of ${t.played}`}
                    className="flex-1 items-center gap-0.5 rounded-xl bg-surface py-3"
                    style={card}
                  >
                    <Text className="text-lg font-bold text-foreground">
                      {t.won}/{t.played}
                    </Text>
                    <Text className="text-xs text-muted">{label}</Text>
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}
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
        <ContinueCards />
        {available.map((entry) => (
          <GameCard key={entry.id} entry={entry} />
        ))}
        <FriendsOnline />
        <Records />
        <ComingSoon />
        <Text className="px-6 text-xs text-muted">
          Games against the computer run only on this phone, and your results stay here. PingDost
          keeps no record of the games you play.
        </Text>
      </ScrollView>
    </View>
  );
}
