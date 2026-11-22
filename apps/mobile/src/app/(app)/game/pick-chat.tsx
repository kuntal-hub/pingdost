import { useLocalSearchParams } from 'expo-router';

import { PickChatScreen } from '@/screens/games/pick-chat';
import { isPlayableGameType } from '@pingdost/games';

export default function PickChatRoute() {
  const { game = '' } = useLocalSearchParams<{ game: string }>();
  return <PickChatScreen game={isPlayableGameType(game) ? game : 'ludo'} />;
}
