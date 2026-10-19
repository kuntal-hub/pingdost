import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineBanner } from './offline-banner';

interface ScreenProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Shows a banner while the phone has no connection. */
  offlineBanner?: boolean;
  /** For screens without a navigation header: keeps content clear of the status bar. */
  headerless?: boolean;
}

/** A scrolling page with the standard padding; taps reach buttons while the keyboard is up. */
export function Screen({
  title,
  subtitle,
  children,
  offlineBanner = false,
  headerless = false,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 p-5"
      contentContainerStyle={headerless ? { paddingTop: insets.top + 20 } : undefined}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      {offlineBanner && <OfflineBanner />}
      {(title || subtitle) && (
        <View className="gap-1">
          {title && (
            <Text accessibilityRole="header" className="text-2xl font-bold text-foreground">
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
