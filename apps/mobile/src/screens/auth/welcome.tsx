import { Link, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useGoogleSignIn } from '@/auth/use-google-sign-in';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/button';
import { CheckIcon, Icon, LockIcon, SparklesIcon, UserPlusIcon } from '@/components/icon';
import { Notice } from '@/components/notice';
import { OfflineBanner } from '@/components/offline-banner';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { Wallpaper } from '@/components/wallpaper';
import { useAppearance } from '@/theme/appearance';
import { useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import { colorSchemes, resolvePalette, schemeSwatch } from '@pingdost/ui-tokens';

const ENTER = [0, 80, 160].map((delay) => FadeInDown.duration(320).delay(delay));

/** Pick a vibe before anything else: the whole screen changes as you tap. */
function VibePicker() {
  const scheme = useAppearance((state) => state.prefs.scheme);
  const update = useAppearance((state) => state.update);
  const { dark, palette } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Color scheme"
      className="flex-row flex-wrap justify-center gap-2"
    >
      {colorSchemes.slice(0, 6).map((entry) => {
        const swatch = schemeSwatch(entry.id, dark);
        const selected = entry.id === scheme;
        return (
          <Tap
            key={entry.id}
            accessibilityRole="radio"
            accessibilityLabel={entry.name}
            accessibilityState={{ selected }}
            feedback="selection"
            scaleTo={0.85}
            onPress={() => update({ scheme: entry.id })}
            className="h-11 w-11 items-center justify-center rounded-full"
            style={{
              backgroundImage: `linear-gradient(135deg, ${swatch.from}, ${swatch.to})`,
              borderWidth: selected ? 3 : 0,
              borderColor: palette.foreground,
            }}
          >
            {selected && (
              <Icon
                icon={CheckIcon}
                size={18}
                color={resolvePalette(entry.id, dark)['on-primary']}
                strokeWidth={3}
              />
            )}
          </Tap>
        );
      })}
    </View>
  );
}

export function WelcomeScreen() {
  const router = useRouter();
  const google = useGoogleSignIn();
  const insets = useSafeAreaInsets();
  const { fades } = useMotion();
  const entering = (index: number) => (fades ? { entering: ENTER[index] } : {});

  return (
    <View
      className="flex-1 bg-background px-6"
      style={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 20 }}
    >
      <Wallpaper id="aurora" />
      <OfflineBanner />
      <View className="flex-1 justify-center">
        <Animated.View className="items-start gap-5" {...entering(0)}>
          <BrandMark size={84} />
          <Text accessibilityRole="header" className="font-display text-5xl text-foreground">
            PingDost
          </Text>
          <Text className="text-xl font-semibold text-foreground">
            Your people. Your phone. Nobody else.
          </Text>
          <View className="flex-row items-start gap-2">
            <Icon icon={LockIcon} size={18} color="accent" />
            <Text className="flex-1 text-base text-muted">
              Your chats are end-to-end encrypted and stored on your devices, with no permanent
              server-side chat history.
            </Text>
          </View>
        </Animated.View>
      </View>

      <Animated.View className="gap-3 pb-5" {...entering(1)}>
        <View className="flex-row items-center justify-center gap-1">
          <Icon icon={SparklesIcon} size={16} color="muted" />
          <Text className="font-bold text-muted">Pick your vibe</Text>
        </View>
        <VibePicker />
      </Animated.View>

      <Animated.View className="gap-3" {...entering(2)}>
        <Button
          label="Create account"
          icon={UserPlusIcon}
          feedback="light"
          onPress={() => router.push('/register')}
        />
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
        {__DEV__ && (
          <Link href="/crypto" asChild>
            <Pressable accessibilityRole="link" className="items-center pt-1">
              <Text className="text-accent">Crypto interop (dev)</Text>
            </Pressable>
          </Link>
        )}
      </Animated.View>
    </View>
  );
}
