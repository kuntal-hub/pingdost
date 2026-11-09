import { cssInterop } from 'nativewind';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandMark } from './brand';
import { useTabBarInset } from './floating-tab-bar';
import { OfflineBanner } from './offline-banner';
import { Text } from './text';
import { Wallpaper } from './wallpaper';

// Classes work on it as on React Native's own ScrollView.
cssInterop(KeyboardAwareScrollView, {
  className: 'style',
  contentContainerClassName: 'contentContainerStyle',
});

/**
 * Room kept between the keyboard and the focused field: enough for the button that usually
 * follows a form's last field to stay in view too.
 */
const KEYBOARD_GAP = 96;

interface ScreenProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Shows a banner while the phone has no connection. */
  offlineBanner?: boolean;
  /** For screens without a navigation header: keeps content clear of the status bar. */
  headerless?: boolean;
  /** The first screen of a tab: keeps content clear of the floating tab bar. */
  tabRoot?: boolean;
  /** The sign-in and sign-up look: PingDost's mark and name over the welcome wallpaper. */
  brand?: boolean;
}

/** PingDost's mark and name, at the top of the account screens. */
function BrandHeader() {
  return (
    <View className="flex-row items-center gap-3">
      <BrandMark size={44} animated={false} />
      <Text className="font-display text-2xl text-foreground">PingDost</Text>
    </View>
  );
}

/**
 * A scrolling page with the standard padding. The focused field scrolls clear of the keyboard,
 * and taps reach buttons while the keyboard is up.
 */
export function Screen({
  title,
  subtitle,
  children,
  offlineBanner = false,
  headerless = false,
  tabRoot = false,
  brand = false,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const tabInset = useTabBarInset();
  const page = (
    <KeyboardAwareScrollView
      bottomOffset={KEYBOARD_GAP}
      className={brand ? 'flex-1' : 'flex-1 bg-background'}
      contentContainerClassName="gap-5 p-5"
      contentContainerStyle={{
        ...(headerless ? { paddingTop: insets.top + 20 } : {}),
        paddingBottom: tabRoot ? tabInset : Math.max(insets.bottom, 20) + 12,
      }}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      {offlineBanner && <OfflineBanner />}
      {brand && <BrandHeader />}
      {(title || subtitle) && (
        <View className="gap-1">
          {title && (
            <Text accessibilityRole="header" className="font-display text-3xl text-foreground">
              {title}
            </Text>
          )}
          {subtitle && <Text className="text-base text-muted">{subtitle}</Text>}
        </View>
      )}
      {children}
    </KeyboardAwareScrollView>
  );
  if (!headerless && !brand) return page;
  return (
    <View className="flex-1 bg-background">
      {brand && <Wallpaper id="aurora" />}
      {page}
      {headerless && <StatusBarBand />}
    </View>
  );
}

/** Covers the status bar, so content scrolling under it never collides with the clock and icons. */
export function StatusBarBand() {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="none"
      className="absolute left-0 right-0 top-0 bg-background"
      style={{ height: insets.top }}
    />
  );
}

/** The big headline at the top of a tab, with room for actions on the right. */
export function TabHeader({ title, children }: { title: string; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-row items-center gap-2 bg-background px-5 pb-2"
      style={{ paddingTop: insets.top + 12 }}
    >
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        className="flex-1 font-display text-3xl text-foreground"
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
