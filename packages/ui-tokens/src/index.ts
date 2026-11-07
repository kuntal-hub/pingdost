// @pingdost/ui-tokens: the design system shared by NativeWind (mobile) and Tailwind (web), ADR
// 0035. Colors and radii become CSS variables, so one class such as `bg-surface` or `rounded-lg`
// follows the user's scheme, mode and corner setting.
import { cornerRadii, type Corners, type RadiusName } from './appearance';
import { toRgbChannels } from './color';
import { colorNames, type ColorName, type Palette } from './schemes';

export * from './appearance';
export * from './color';
export * from './schemes';
export * from './wallpapers';

/** Spacing scale in density-independent pixels (Tailwind `p-1` … `p-16`). */
export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  2.5: 10,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  9: 36,
  10: 40,
  // 44: the minimum touch target.
  11: 44,
  12: 48,
  14: 56,
  16: 64,
} as const;

/** Named durations in milliseconds, so motion feels related across the app. */
export const motion = { press: 120, small: 180, base: 240, large: 320 } as const;

/** Text sizes `[size, line height]` in density-independent pixels, before the user's scale. */
export const typeScale = {
  xs: [12, 16],
  sm: [14, 20],
  base: [16, 22],
  lg: [18, 24],
  xl: [20, 26],
  '2xl': [24, 30],
  '3xl': [30, 36],
  '4xl': [36, 42],
  '5xl': [46, 50],
} as const;

/** The emoji offered as quick reactions. Reactions are content, so they stay emoji. */
export const quickReactions = ['❤️', '😂', '🔥', '😮', '😢', '👍'] as const;

/** The CSS variables for one palette, e.g. `{ '--color-primary': '198 241 53' }`. */
export function colorVariables(palette: Palette): Record<`--color-${ColorName}`, string> {
  return Object.fromEntries(
    colorNames.map((name) => [`--color-${name}`, toRgbChannels(palette[name])]),
  ) as Record<`--color-${ColorName}`, string>;
}

/** Tailwind `theme.colors` entries that read the CSS variables. */
export function tailwindColors(): Record<ColorName, string> {
  return Object.fromEntries(
    colorNames.map((name) => [name, `rgb(var(--color-${name}) / <alpha-value>)`]),
  ) as Record<ColorName, string>;
}

const radiusNames: RadiusName[] = ['sm', 'md', 'lg', 'xl', '2xl'];

/** The CSS variables for a corner setting, in pixels as numbers: `{ '--radius-md': 14 }`. */
export function radiusVariables(corners: Corners): Record<`--radius-${RadiusName}`, number> {
  return Object.fromEntries(
    radiusNames.map((name) => [`--radius-${name}`, cornerRadii[corners][name]]),
  ) as Record<`--radius-${RadiusName}`, number>;
}

/** Tailwind `theme.borderRadius` entries that read the radius variables. */
export function tailwindRadii(): Record<RadiusName | 'none' | 'full', string> {
  return {
    none: '0px',
    full: '9999px',
    ...(Object.fromEntries(radiusNames.map((name) => [name, `var(--radius-${name})`])) as Record<
      RadiusName,
      string
    >),
  };
}
