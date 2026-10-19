import { Stack } from 'expo-router';

// Deep links into a chat still have the tabs underneath to go back to.
export const unstable_settings = { anchor: '(tabs)' };

/** The signed-in app: the tabs, with chats and contacts pushed over them (no tab bar there). */
export default function AppStack() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="chat/[conversationId]" options={{ title: '' }} />
      <Stack.Screen name="new-chat" options={{ title: 'New chat' }} />
      <Stack.Screen name="contact/[userId]" options={{ title: 'Contact info' }} />
      <Stack.Screen name="scan/[userId]" options={{ title: 'Scan safety code' }} />
      <Stack.Screen
        name="message-info/[messageId]"
        options={{ title: 'Message info', presentation: 'modal' }}
      />
    </Stack>
  );
}
