import { ActivityIndicator, Pressable, Text } from 'react-native';

import { usePalette } from '@/theme/theme-root';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}

const containers: Record<Variant, string> = {
  primary: 'bg-primary',
  secondary: 'border border-border bg-surface',
  ghost: '',
  danger: 'border border-danger',
};

const labels: Record<Variant, string> = {
  primary: 'text-on-primary',
  secondary: 'text-foreground',
  ghost: 'text-primary',
  danger: 'text-danger',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  accessibilityHint,
}: ButtonProps) {
  const palette = usePalette();
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      className={`min-h-[48px] flex-row items-center justify-center gap-2 rounded-md px-4 py-3 active:opacity-80 ${
        containers[variant]
      } ${inactive ? 'opacity-60' : ''}`}
    >
      {loading && (
        <ActivityIndicator
          color={variant === 'primary' ? palette['on-primary'] : palette.primary}
        />
      )}
      <Text className={`text-base font-semibold ${labels[variant]}`}>{label}</Text>
    </Pressable>
  );
}
