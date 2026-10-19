import { Link, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { useGoogleSignIn } from '@/auth/use-google-sign-in';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';

export function WelcomeScreen() {
  const router = useRouter();
  const google = useGoogleSignIn();

  return (
    <Screen offlineBanner headerless>
      <View className="gap-2 pt-8">
        <Text accessibilityRole="header" className="text-3xl font-bold text-foreground">
          PingDost
        </Text>
        <Text className="text-lg text-muted">
          Private messaging. Your chats are end-to-end encrypted and stored on your devices, with no
          permanent server-side chat history.
        </Text>
      </View>

      <View className="gap-3 pt-6">
        <Button label="Create account" onPress={() => router.push('/register')} />
        <Button label="Log in" variant="secondary" onPress={() => router.push('/login')} />
        {google.available && (
          <Button
            label="Continue with Google"
            variant="secondary"
            loading={google.busy}
            onPress={() => void google.signIn()}
          />
        )}
        {google.error && <Notice tone="error" message={google.error} />}
      </View>

      {__DEV__ && (
        <Link href="/crypto" asChild>
          <Pressable accessibilityRole="link" className="items-center pt-6">
            <Text className="text-primary">Crypto interop (dev)</Text>
          </Pressable>
        </Link>
      )}
    </Screen>
  );
}
