import '../polyfills';
import '../global.css';

import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { LogBox, Text, View } from 'react-native';

import { authStore } from '@/api';
import { useAppStage } from '@/auth/use-auth';
import { configError } from '@/config';
import { replenishKeys } from '@/device';
import { ThemeRoot } from '@/theme/theme-root';

// react-native-css-interop (NativeWind 4) wraps ImageBackground at import time; the app
// does not use it.
LogBox.ignoreLogs(['ImageBackground is deprecated']);

void SplashScreen.preventAutoHideAsync();

/** A build without `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_WS_URL` cannot do anything useful. */
function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <View className="flex-1 justify-center gap-2 bg-background p-6">
      <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
        This build is missing its configuration
      </Text>
      <Text className="text-muted">{message}</Text>
      <Text className="text-muted">Set the values in apps/mobile/.env and restart Metro.</Text>
    </View>
  );
}

/**
 * The auth gate: each stage unlocks one group of routes. When a guard turns off, Expo Router
 * falls back to `index`, which redirects to the stage's first screen. The splash screen stays
 * up until the stored session is loaded.
 */
export default function RootLayout() {
  const stage = useAppStage();

  useEffect(() => {
    void authStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (configError || stage !== 'loading') void SplashScreen.hideAsync();
    // Tops up one-time keys on every start; a failure just waits for the next one.
    if (stage === 'ready') void replenishKeys().catch(() => undefined);
  }, [stage]);

  if (configError) {
    return (
      <ThemeRoot>
        <ConfigErrorScreen message={configError} />
      </ThemeRoot>
    );
  }

  const signedOut = stage === 'signedOut' || stage === 'needsUsername';
  return (
    <ThemeRoot>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Protected guard={signedOut}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        <Stack.Protected guard={stage === 'deviceSetup'}>
          <Stack.Screen name="setup" />
        </Stack.Protected>
        <Stack.Protected guard={stage === 'ready'}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={__DEV__}>
          <Stack.Screen
            name="(dev)/crypto"
            options={{ headerShown: true, title: 'Crypto interop (dev)' }}
          />
        </Stack.Protected>
      </Stack>
    </ThemeRoot>
  );
}
