import { Stack } from 'expo-router';

import { useAppStage } from '@/auth/use-auth';

export default function AuthLayout() {
  const needsUsername = useAppStage() === 'needsUsername';
  return (
    <Stack
      screenOptions={{
        title: '',
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Protected guard={!needsUsername}>
        <Stack.Screen name="welcome" options={{ headerShown: false }} />
        <Stack.Screen name="register" />
        <Stack.Screen name="verify-otp" />
        <Stack.Screen name="login" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="reset-password" />
      </Stack.Protected>
      <Stack.Protected guard={needsUsername}>
        <Stack.Screen name="google-username" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}
