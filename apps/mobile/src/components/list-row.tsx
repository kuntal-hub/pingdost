import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '@/theme/theme-root';

import { ChevronRightIcon, Icon, type LucideIcon } from './icon';
import { Text } from './text';

export type RowTone = 'accent' | 'secondary' | 'success' | 'warning' | 'danger' | 'muted';

const TILES: Record<RowTone, string> = {
  accent: 'bg-accent/15',
  secondary: 'bg-secondary/15',
  success: 'bg-success/15',
  warning: 'bg-warning/15',
  danger: 'bg-danger/15',
  muted: 'bg-raised',
};

interface ListRowProps {
  title: string;
  subtitle?: string;
  onPress?: () => void;
  /** Shown on the right, e.g. a switch or a value. */
  accessory?: ReactNode;
  destructive?: boolean;
  /** Shown in a tinted tile on the left. */
  icon?: LucideIcon;
  tone?: RowTone;
}

/** One settings row; pressable rows show a chevron. */
export function ListRow({
  title,
  subtitle,
  onPress,
  accessory,
  destructive,
  icon,
  tone = destructive ? 'danger' : 'accent',
}: ListRowProps) {
  const { prefs } = useTheme();
  const compact = prefs.density === 'compact';
  const body = (
    <View
      className={`flex-row items-center gap-3 px-4 ${compact ? 'min-h-[52px] py-2' : 'min-h-[60px] py-3'}`}
    >
      {icon && (
        <View className={`h-[38px] w-[38px] items-center justify-center rounded-md ${TILES[tone]}`}>
          <Icon icon={icon} size={20} color={tone === 'muted' ? 'muted' : tone} />
        </View>
      )}
      <View className="flex-1 gap-1">
        <Text
          className={`text-base font-semibold ${destructive ? 'text-danger' : 'text-foreground'}`}
        >
          {title}
        </Text>
        {subtitle && <Text className="text-muted">{subtitle}</Text>}
      </View>
      {accessory}
      {onPress && !accessory && <Icon icon={ChevronRightIcon} size={20} color="muted" />}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      onPress={onPress}
      className="active:bg-raised"
    >
      {body}
    </Pressable>
  );
}

/** A titled group of rows on one surface, with hairlines between them. */
export function ListSection({ title, children }: { title?: string; children: ReactNode }) {
  const { card } = useTheme();
  const rows = Children.toArray(children);
  return (
    <View className="gap-2">
      {title && (
        <Text accessibilityRole="header" className="px-2 font-bold text-muted">
          {title}
        </Text>
      )}
      <View className="overflow-hidden rounded-xl bg-surface" style={card}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 && <View className="ml-4 h-px bg-border" />}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}
