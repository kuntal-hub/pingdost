import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { ForwardScreen } from '@/screens/chats/forward';

export default function ForwardRoute() {
  const { messageIds } = useLocalSearchParams<{ messageIds?: string }>();
  const ids = useMemo(
    () => (messageIds ? messageIds.split(',').filter(Boolean) : []),
    [messageIds],
  );
  return <ForwardScreen messageIds={ids} />;
}
