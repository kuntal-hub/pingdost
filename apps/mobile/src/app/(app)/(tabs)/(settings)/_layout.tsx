import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'settings' };

export default function SettingsStack() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="settings" options={{ title: 'Settings', headerShown: false }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
      <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="blocked" options={{ title: 'Blocked contacts' }} />
      <Stack.Screen name="devices" options={{ title: 'Devices' }} />
      <Stack.Screen name="link-browser" options={{ title: 'Link a browser' }} />
      <Stack.Screen name="storage" options={{ title: 'Storage' }} />
      <Stack.Screen name="backup" options={{ title: 'Backup' }} />
      <Stack.Screen name="storage-chat" options={{ title: 'Chat files' }} />
      <Stack.Screen name="nearby-messaging" options={{ title: 'Nearby messaging' }} />
      <Stack.Screen name="nearby-setup" options={{ title: 'Turn on nearby messaging' }} />
      <Stack.Screen name="nearby-relay" options={{ title: 'Nearby relay' }} />
      <Stack.Screen name="about-privacy" options={{ title: 'About privacy' }} />
    </Stack>
  );
}
