import { Stack, useLocalSearchParams } from 'expo-router';

import { TurnSetupScreen } from '@/screens/games/turn/turn-setup';
import { catalogEntry, isTurnGameId } from '@pingdost/games';

export default function TurnSetupRoute() {
  const { game = '' } = useLocalSearchParams<{ game: string }>();
  const id = isTurnGameId(game) ? game : 'tic-tac-toe';
  return (
    <>
      <Stack.Screen options={{ title: `Play ${catalogEntry(id).name}` }} />
      <TurnSetupScreen game={id} />
    </>
  );
}
