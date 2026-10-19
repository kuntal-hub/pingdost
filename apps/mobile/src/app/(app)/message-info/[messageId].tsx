import { useLocalSearchParams } from 'expo-router';

import { MessageInfoScreen } from '@/screens/chats/message-info';

export default function MessageInfoRoute() {
  const { messageId } = useLocalSearchParams<{ messageId: string }>();
  return <MessageInfoScreen messageId={messageId} />;
}
