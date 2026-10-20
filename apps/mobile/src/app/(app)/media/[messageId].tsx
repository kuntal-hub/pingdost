import { useLocalSearchParams } from 'expo-router';

import { MediaViewerScreen } from '@/screens/chats/media-viewer';

export default function MediaRoute() {
  const { messageId } = useLocalSearchParams<{ messageId: string }>();
  return <MediaViewerScreen messageId={messageId} />;
}
