// A game with friends: Ludo or a turn game, by the game's type (Phases 42–43).
import { Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { EmptyState } from '@/components/feedback';
import { DicesIcon } from '@/components/icon';
import { turnRulesOf, useGameRecord } from '@/games/network';
import { LudoNetScreen } from '@/screens/games/ludo/ludo-net-screen';
import { TurnNetScreen } from '@/screens/games/turn/turn-net-screen';

export default function GameRoute() {
  const { gameId = '', join } = useLocalSearchParams<{ gameId: string; join?: string }>();
  const record = useGameRecord(gameId);
  const type = record?.gameType;
  if (type === 'ludo') return <LudoNetScreen gameId={gameId} join={join === '1'} />;
  const rules = turnRulesOf(type);
  if (rules)
    return <TurnNetScreen key={gameId} gameId={gameId} join={join === '1'} rules={rules} />;
  const unknown = type !== undefined && type !== 'unknown';
  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ title: 'Game' }} />
      <EmptyState
        icon={DicesIcon}
        title={unknown ? 'Update PingDost to play' : 'Opening the game…'}
        message={
          unknown
            ? 'This game is newer than this version of the app.'
            : 'Games with friends live in their chat.'
        }
      />
    </View>
  );
}
