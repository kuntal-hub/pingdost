import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'calls' };

export default function CallsStack() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false }}>
      <Stack.Screen name="calls" options={{ title: 'Calls' }} />
    </Stack>
  );
}
