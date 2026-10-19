import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

interface ListRowProps {
  title: string;
  subtitle?: string;
  onPress?: () => void;
  /** Shown on the right, e.g. a switch or a value. */
  accessory?: ReactNode;
  destructive?: boolean;
}

/** One settings row; pressable rows show a chevron. */
export function ListRow({ title, subtitle, onPress, accessory, destructive }: ListRowProps) {
  const body = (
    <View className="min-h-[56px] flex-row items-center gap-3 px-4 py-3">
      <View className="flex-1 gap-1">
        <Text className={`text-base ${destructive ? 'text-danger' : 'text-foreground'}`}>
          {title}
        </Text>
        {subtitle && <Text className="text-muted">{subtitle}</Text>}
      </View>
      {accessory}
      {onPress && !accessory && (
        <Text importantForAccessibility="no" className="text-xl text-muted">
          ›
        </Text>
      )}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      onPress={onPress}
      className="active:opacity-70"
    >
      {body}
    </Pressable>
  );
}

/** A titled group of rows on a surface card. */
export function ListSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      {title && (
        <Text accessibilityRole="header" className="px-1 font-semibold text-muted">
          {title}
        </Text>
      )}
      <View className="overflow-hidden rounded-lg border border-border bg-surface">{children}</View>
    </View>
  );
}
