import { useLocalSearchParams } from 'expo-router';

import { LudoNetScreen } from '@/screens/games/ludo/ludo-net-screen';

export default function LudoNetRoute() {
  const { gameId = '', join } = useLocalSearchParams<{ gameId: string; join?: string }>();
  return <LudoNetScreen gameId={gameId} join={join === '1'} />;
}
