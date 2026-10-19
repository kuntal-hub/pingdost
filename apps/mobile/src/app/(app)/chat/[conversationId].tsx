import { useLocalSearchParams } from 'expo-router';

import { ChatScreen } from '@/screens/chats/chat';

export default function ChatRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  return <ChatScreen key={conversationId} conversationId={conversationId} />;
}
