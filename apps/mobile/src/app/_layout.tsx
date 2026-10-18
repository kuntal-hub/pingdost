import '../global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogBox } from 'react-native';

import { ThemeRoot } from '@/theme/theme-root';

// react-native-css-interop (NativeWind 4) wraps ImageBackground at import time; the app
// does not use it.
LogBox.ignoreLogs(['ImageBackground is deprecated']);

export default function RootLayout() {
  return (
    <ThemeRoot>
      <StatusBar style="auto" />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'PingDost' }} />
        <Stack.Screen name="(dev)/crypto" options={{ title: 'Crypto interop (dev)' }} />
      </Stack>
    </ThemeRoot>
  );
}
