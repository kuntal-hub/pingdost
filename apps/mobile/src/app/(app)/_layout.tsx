import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { conversationOf } from '@/push/notifications';

// Deep links into a chat still have the tabs underneath to go back to.
export const unstable_settings = { anchor: '(tabs)' };

/** Opens the chat of a tapped message notification, also when the tap launched the app. */
function useNotificationTaps(): void {
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const conversationId = conversationOf(response);
    if (!conversationId) return;
    router.push({ pathname: '/chat/[conversationId]', params: { conversationId } });
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  }, [response, router]);
}

/** The signed-in app: the tabs, with chats and contacts pushed over them (no tab bar there). */
export default function AppStack() {
  useNotificationTaps();
  return (
    <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="chat/[conversationId]" options={{ title: '' }} />
      <Stack.Screen name="new-chat" options={{ title: 'New chat' }} />
      <Stack.Screen name="new-group" options={{ title: 'New group' }} />
      <Stack.Screen name="group/[groupId]" options={{ title: 'Group info' }} />
      <Stack.Screen name="add-members/[groupId]" options={{ title: 'Add members' }} />
      <Stack.Screen name="search" options={{ title: 'Search' }} />
      <Stack.Screen name="archived" options={{ title: 'Archived chats' }} />
      <Stack.Screen name="contact/[userId]" options={{ title: 'Contact info' }} />
      <Stack.Screen name="report/[userId]" options={{ title: 'Report' }} />
      <Stack.Screen name="scan/[userId]" options={{ title: 'Scan safety code' }} />
      <Stack.Screen
        name="message-info/[messageId]"
        options={{ title: 'Message info', presentation: 'modal' }}
      />
    </Stack>
  );
}
