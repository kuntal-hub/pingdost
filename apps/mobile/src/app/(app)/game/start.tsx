import { useLocalSearchParams } from 'expo-router';

import { StartGameScreen } from '@/screens/games/start-game';
import { isPlayableGameType } from '@pingdost/games';

export default function StartGameRoute() {
  const { conversationId = '', game } = useLocalSearchParams<{
    conversationId: string;
    game?: string;
  }>();
  return (
    <StartGameScreen
      conversationId={conversationId}
      initialGame={game && isPlayableGameType(game) ? game : undefined}
    />
  );
}
