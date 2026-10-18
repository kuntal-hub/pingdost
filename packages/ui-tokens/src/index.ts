// @pingdost/ui-tokens: shared design tokens for NativeWind (mobile) and Tailwind (web).
// Colors become CSS variables (`--color-<name>` as "R G B" channels) so one class such as
// `bg-surface` follows the light or dark theme.

export const colorNames = [
  'background',
  'surface',
  'foreground',
  'muted',
  'border',
  'primary',
  'on-primary',
  'success',
  'danger',
] as const;

export type ColorName = (typeof colorNames)[number];
export type ColorScheme = 'light' | 'dark';
export type Palette = Record<ColorName, string>;

export const palettes: Record<ColorScheme, Palette> = {
  light: {
    background: '#FFFFFF',
    surface: '#F3F5F7',
    foreground: '#0F172A',
    muted: '#5B6B7F',
    border: '#DCE2E8',
    primary: '#0B7A64',
    'on-primary': '#FFFFFF',
    success: '#15803D',
    danger: '#B42318',
  },
  dark: {
    background: '#0B1220',
    surface: '#131C2E',
    foreground: '#E5EAF0',
    muted: '#93A1B2',
    border: '#243044',
    primary: '#34D3B4',
    'on-primary': '#03231C',
    success: '#4ADE80',
    danger: '#F87171',
  },
};

/** Spacing scale in density-independent pixels (Tailwind `p-1` … `p-8`). */
export const spacing = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;

/** Corner radii in density-independent pixels. */
export const radii = { sm: 6, md: 10, lg: 16, full: 9999 } as const;

/** `#RRGGBB` → `"R G B"`, the channel form Tailwind's `<alpha-value>` needs. */
export function toRgbChannels(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`expected #RRGGBB, got ${hex}`);
  return match
    .slice(1)
    .map((part) => parseInt(part, 16))
    .join(' ');
}

/** The CSS variables for one scheme, e.g. `{ '--color-primary': '11 122 100' }`. */
export function colorVariables(scheme: ColorScheme): Record<`--color-${ColorName}`, string> {
  return Object.fromEntries(
    colorNames.map((name) => [`--color-${name}`, toRgbChannels(palettes[scheme][name])]),
  ) as Record<`--color-${ColorName}`, string>;
}

/** Tailwind `theme.colors` entries that read the CSS variables. */
export function tailwindColors(): Record<ColorName, string> {
  return Object.fromEntries(
    colorNames.map((name) => [name, `rgb(var(--color-${name}) / <alpha-value>)`]),
  ) as Record<ColorName, string>;
}
