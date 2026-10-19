import { useLocalSearchParams } from 'expo-router';

import { ChatScreen } from '@/screens/chats/chat';

export default function ChatRoute() {
  // `messageId`: a search result to scroll to.
  const { conversationId, messageId } = useLocalSearchParams<{
    conversationId: string;
    messageId?: string;
  }>();
  return (
    <ChatScreen key={conversationId} conversationId={conversationId} focusMessageId={messageId} />
  );
}
