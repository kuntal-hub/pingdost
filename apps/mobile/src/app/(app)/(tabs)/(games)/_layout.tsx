import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'games' };

export default function GamesStack() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false }}>
      <Stack.Screen name="games" options={{ title: 'Games', headerShown: false }} />
    </Stack>
  );
}
