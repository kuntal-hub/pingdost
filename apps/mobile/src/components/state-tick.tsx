import { usePalette } from '@/theme/theme-root';
import type { StateIcon } from '@pingdost/chat-core';
import { withAlpha, type ColorName } from '@pingdost/ui-tokens';

import {
  CheckCheckIcon,
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  HourglassIcon,
  Icon,
  type LucideIcon,
} from './icon';

const MARKS: Record<StateIcon, { icon: LucideIcon; color: ColorName }> = {
  pending: { icon: ClockIcon, color: 'muted' },
  sent: { icon: CheckIcon, color: 'muted' },
  delivered: { icon: CheckCheckIcon, color: 'muted' },
  read: { icon: CheckCheckIcon, color: 'accent' },
  expired: { icon: HourglassIcon, color: 'danger' },
  failed: { icon: CircleAlertIcon, color: 'danger' },
};

/**
 * A message's delivery state as an icon. On a brand-colored bubble (`onBrand`) the accent would
 * not show, so "read" is solid and bolder and the rest are faded: the two double ticks stay
 * different at a glance.
 */
export function StateTick({
  icon,
  size = 16,
  onBrand = false,
}: {
  icon: StateIcon;
  size?: number;
  onBrand?: boolean;
}) {
  const palette = usePalette();
  const mark = MARKS[icon];
  const danger = mark.color === 'danger';
  const read = icon === 'read';
  const color =
    onBrand && !danger
      ? read
        ? palette['on-primary']
        : withAlpha(palette['on-primary'], 0.55)
      : mark.color;
  return <Icon icon={mark.icon} size={size} color={color} strokeWidth={read ? 3 : 2.4} />;
}
