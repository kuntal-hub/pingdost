import { useLocalSearchParams } from 'expo-router';

import { StartGameScreen } from '@/screens/games/start-game';

export default function StartGameRoute() {
  const { conversationId = '' } = useLocalSearchParams<{ conversationId: string }>();
  return <StartGameScreen conversationId={conversationId} />;
}
