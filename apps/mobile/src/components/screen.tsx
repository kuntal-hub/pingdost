import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTabBarInset } from './floating-tab-bar';
import { OfflineBanner } from './offline-banner';
import { Text } from './text';

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
}

/** A scrolling page with the standard padding; taps reach buttons while the keyboard is up. */
export function Screen({
  title,
  subtitle,
  children,
  offlineBanner = false,
  headerless = false,
  tabRoot = false,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const tabInset = useTabBarInset();
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-5 p-5"
      contentContainerStyle={{
        ...(headerless ? { paddingTop: insets.top + 20 } : {}),
        paddingBottom: tabRoot ? tabInset : Math.max(insets.bottom, 20) + 12,
      }}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      {offlineBanner && <OfflineBanner />}
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
    </ScrollView>
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
        className="flex-1 font-display text-4xl text-foreground"
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
