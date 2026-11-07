import { ActivityIndicator, View, type StyleProp, type ViewStyle } from 'react-native';

import { usePalette, useTheme } from '@/theme/theme-root';
import { brandGradient } from '@pingdost/ui-tokens';

import { Icon, type LucideIcon } from './icon';
import { Tap, type TapProps } from './tap';
import { Text } from './text';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  feedback?: TapProps['feedback'];
}

const labels: Record<Variant, string> = {
  primary: 'text-on-primary',
  secondary: 'text-foreground',
  ghost: 'text-accent',
  danger: 'text-danger',
};

const iconColors = {
  primary: 'on-primary',
  secondary: 'foreground',
  ghost: 'accent',
  danger: 'danger',
} as const;

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  loading = false,
  disabled = false,
  accessibilityHint,
  feedback,
}: ButtonProps) {
  const { card, prefs } = useTheme();
  const palette = usePalette();
  const inactive = disabled || loading;
  const look: StyleProp<ViewStyle> =
    variant === 'primary'
      ? {
          backgroundImage: brandGradient(palette),
          ...(prefs.look === 'sticker' ? card : {}),
        }
      : variant === 'secondary'
        ? { backgroundColor: palette.surface, ...card }
        : variant === 'danger'
          ? { backgroundColor: `${palette.danger}1F` }
          : undefined;
  return (
    <Tap
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      {...(feedback ? { feedback } : {})}
      className={`min-h-[52px] flex-row items-center justify-center gap-2 rounded-lg px-5 py-3 ${
        inactive ? 'opacity-60' : ''
      }`}
      style={look}
    >
      {loading ? (
        <ActivityIndicator color={palette[iconColors[variant]]} />
      ) : icon ? (
        <View importantForAccessibility="no">
          <Icon icon={icon} size={20} color={iconColors[variant]} />
        </View>
      ) : null}
      <Text className={`text-base font-bold ${labels[variant]}`}>{label}</Text>
    </Tap>
  );
}
