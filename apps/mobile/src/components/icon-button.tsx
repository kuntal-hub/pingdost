import { usePalette, useTheme } from '@/theme/theme-root';
import { brandGradient } from '@pingdost/ui-tokens';

import { Icon, type LucideIcon } from './icon';
import { Tap, type TapProps } from './tap';

type Variant = 'plain' | 'soft' | 'surface' | 'brand' | 'danger';

interface IconButtonProps extends Pick<TapProps, 'disabled' | 'feedback' | 'accessibilityHint'> {
  icon: LucideIcon;
  /** Screen readers read this; icon-only controls have nothing else. */
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: number;
  filled?: boolean;
}

const COLORS = {
  plain: 'foreground',
  soft: 'accent',
  surface: 'foreground',
  brand: 'on-primary',
  danger: 'on-danger',
} as const;

/** A round icon button with at least a 44 pt touch target. */
export function IconButton({
  icon,
  label,
  onPress,
  variant = 'plain',
  size = 44,
  filled = false,
  disabled,
  feedback,
  accessibilityHint,
}: IconButtonProps) {
  const { palette, floating, prefs } = useTheme();
  const brandPalette = usePalette();
  const slop = Math.max(0, Math.ceil((44 - size) / 2));
  return (
    <Tap
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(feedback ? { feedback } : {})}
      onPress={onPress}
      hitSlop={slop}
      scaleTo={0.88}
      className={`items-center justify-center rounded-full ${disabled ? 'opacity-50' : ''}`}
      style={[
        { width: size, height: size },
        variant === 'soft' && { backgroundColor: `${palette.accent}1F` },
        variant === 'surface' && { backgroundColor: palette.surface, ...floating },
        variant === 'brand' && {
          backgroundImage: brandGradient(brandPalette),
          ...(prefs.look === 'sticker' ? floating : {}),
        },
        variant === 'danger' && { backgroundColor: palette.danger },
      ]}
    >
      <Icon icon={icon} size={Math.round(size * 0.5)} color={COLORS[variant]} filled={filled} />
    </Tap>
  );
}
