import '../polyfills';
import '../global.css';

import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { LogBox, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { authStore } from '@/api';
import { useAppStage } from '@/auth/use-auth';
import { Text } from '@/components/text';
import { configError } from '@/config';
import { startChat, stopChat } from '@/engine/runtime';
import { startPushToken } from '@/push/token';
import { useAppearance } from '@/theme/appearance';
import { loadFont } from '@/theme/fonts';
import { ThemeRoot, useTheme } from '@/theme/theme-root';

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

/** Status bar icons follow the app's mode, which may differ from the device's. */
function ThemedStatusBar() {
  const { dark } = useTheme();
  return <StatusBar style={dark ? 'light' : 'dark'} />;
}

/**
 * The auth gate: each stage unlocks one group of routes. When a guard turns off, Expo Router
 * falls back to `index`, which redirects to the stage's first screen. The splash screen stays
 * up until the stored session and the chosen font are loaded.
 */
export default function RootLayout() {
  const stage = useAppStage();
  const [fontSettled, setFontSettled] = useState(false);

  useEffect(() => {
    void authStore.getState().hydrate();
    void loadFont(useAppearance.getState().prefs.font).finally(() => setFontSettled(true));
  }, []);

  useEffect(() => {
    if (configError || (stage !== 'loading' && fontSettled)) void SplashScreen.hideAsync();
  }, [stage, fontSettled]);

  useEffect(() => {
    // The chat engine runs while a registered device is signed in (it also tops up keys), and
    // the server knows where to send its push wakes.
    if (stage !== 'ready') {
      void stopChat();
      return undefined;
    }
    void startChat().catch((error: unknown) => {
      if (__DEV__) console.warn('chat start failed', error);
    });
    const deviceId = authStore.getState().session?.deviceId;
    return deviceId ? startPushToken(deviceId) : undefined;
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Keyboard insets for forms and the composer (Phase 34). */}
      <KeyboardProvider>
        <ThemeRoot>
          <ThemedStatusBar />
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
              <Stack.Screen
                name="(dev)/nearby"
                options={{ headerShown: true, title: 'Nearby spike (dev)' }}
              />
            </Stack.Protected>
          </Stack>
        </ThemeRoot>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
