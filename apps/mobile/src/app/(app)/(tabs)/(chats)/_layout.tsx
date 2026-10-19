import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'chats' };

export default function ChatsStack() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false }}>
      <Stack.Screen name="chats" options={{ title: 'Chats' }} />
    </Stack>
  );
}
