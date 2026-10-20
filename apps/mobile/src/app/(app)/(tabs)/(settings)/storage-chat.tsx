import { useLocalSearchParams } from 'expo-router';

import { ChatStorageScreen } from '@/screens/settings/storage-chat';

export default function ChatStorageRoute() {
  const { conversationId, name } = useLocalSearchParams<{
    conversationId: string;
    name?: string;
  }>();
  return <ChatStorageScreen conversationId={conversationId} name={name ?? 'Chat'} />;
}
