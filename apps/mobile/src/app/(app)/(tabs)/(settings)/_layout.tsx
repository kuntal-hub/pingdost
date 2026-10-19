import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'settings' };

export default function SettingsStack() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy' }} />
      <Stack.Screen name="devices" options={{ title: 'Devices' }} />
      <Stack.Screen name="about-privacy" options={{ title: 'About privacy' }} />
    </Stack>
  );
}
