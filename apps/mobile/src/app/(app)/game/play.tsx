import { useLocalSearchParams } from 'expo-router';

import { TurnSoloScreen } from '@/screens/games/turn/turn-solo-screen';
import { isTurnGameId } from '@pingdost/games';

export default function TurnPlayRoute() {
  const { game = '' } = useLocalSearchParams<{ game: string }>();
  const id = isTurnGameId(game) ? game : 'tic-tac-toe';
  return <TurnSoloScreen key={id} game={id} />;
}
