import { useLocalSearchParams } from 'expo-router';

import { SearchScreen } from '@/screens/chats/search';

export default function SearchRoute() {
  // `conversationId`: search one chat; without it, every chat.
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  return <SearchScreen conversationId={conversationId} />;
}
