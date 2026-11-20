import { View, type ViewStyle } from 'react-native';

import { usePalette } from '@/theme/theme-root';
import type { StateIcon } from '@pingdost/chat-core';
import { DELIVERED_TICK_ALPHA, withAlpha, type ColorName } from '@pingdost/ui-tokens';

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
  read: { icon: CheckCheckIcon, color: 'read' },
  expired: { icon: HourglassIcon, color: 'danger' },
  failed: { icon: CircleAlertIcon, color: 'danger' },
};

/**
 * One stroke of a check mark, in Lucide's 24-unit grid: the corner at (x, y), a short arm up and
 * left, a long arm up and right. Drawn as the bottom and right borders of a box turned 45°.
 */
interface Stroke {
  x: number;
  y: number;
  short: number;
  long: number;
}

const R2 = Math.SQRT2;
// Lucide's `check` (20 6, 9 17, 4 12) and `check-check` (18 6, 7 17, 2 12 and 22 10, 14.5 17.5,
// 13 16), so the drawn ticks match the icons used everywhere else.
const CHECK: Stroke[] = [{ x: 9, y: 17, short: 5 * R2, long: 11 * R2 }];
const CHECK_CHECK: Stroke[] = [
  { x: 7, y: 17, short: 5 * R2, long: 11 * R2 },
  { x: 14.5, y: 17.5, short: 1.5 * R2, long: 7.5 * R2 },
];

const drawnStyles = new Map<string, ViewStyle[]>();

/** The boxes for these strokes at this size (cached: a chat draws the same few many times). */
function strokeStyles(strokes: Stroke[], size: number, width: number, color: string): ViewStyle[] {
  const key = `${strokes.length}:${size}:${width}:${color}`;
  const cached = drawnStyles.get(key);
  if (cached) return cached;
  const unit = size / 24;
  const line = width * unit;
  const styles = strokes.map(({ x, y, short, long }): ViewStyle => {
    // The borders' center lines meet at (short / 2, long / 2) from the box's center; turning
    // the box 45° about its center moves that point by ((a - b) / √2, (a + b) / √2), a and b
    // being those halves. The box is one line wider and taller than the arms, so the borders'
    // center lines are the arms and each free end reaches half a line further, as a round cap.
    const a = short / 2;
    const b = long / 2;
    const centerX = x - (a - b) / R2;
    const centerY = y - (a + b) / R2;
    return {
      position: 'absolute',
      left: (centerX - a) * unit - line / 2,
      top: (centerY - b) * unit - line / 2,
      width: short * unit + line,
      height: long * unit + line,
      borderRightWidth: line,
      borderBottomWidth: line,
      borderBottomRightRadius: line / 2,
      borderColor: color,
      transform: [{ rotate: '45deg' }],
    };
  });
  drawnStyles.set(key, styles);
  return styles;
}

/**
 * A message's delivery state as an icon. "Read" has a color of its own (`read`, or
 * `on-primary-read` on a brand-colored bubble), so it never looks like a darker "delivered":
 * the other ticks are gray, or faded `on-primary` on the bubble. ui-tokens checks the two stay
 * apart in every scheme.
 *
 * The usual ticks (sent, delivered, read) are drawn with plain views, the shapes of Lucide's
 * check icons: a chat opens with a screenful of them, and an SVG icon costs several times more
 * to draw (ADR 0047).
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
        ? palette['on-primary-read']
        : withAlpha(palette['on-primary'], DELIVERED_TICK_ALPHA)
      : palette[mark.color];
  const width = read ? 3 : 2.4;
  if (icon === 'sent' || icon === 'delivered' || icon === 'read') {
    const strokes = strokeStyles(icon === 'sent' ? CHECK : CHECK_CHECK, size, width, color);
    return (
      <View importantForAccessibility="no" style={{ width: size, height: size }}>
        {strokes.map((style, index) => (
          <View key={index} style={style} />
        ))}
      </View>
    );
  }
  return <Icon icon={mark.icon} size={size} color={color} strokeWidth={width} />;
}
