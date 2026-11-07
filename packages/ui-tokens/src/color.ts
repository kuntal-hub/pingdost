// Small color helpers shared by the palettes, the avatars and the tests.

/** `#RRGGBB` → `"R G B"`, the channel form Tailwind's `<alpha-value>` needs. */
export function toRgbChannels(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`expected #RRGGBB, got ${hex}`);
  return match
    .slice(1)
    .map((part) => parseInt(part, 16))
    .join(' ');
}

/** `#RRGGBB` plus an alpha, for props that take a plain color string. */
export function withAlpha(hex: string, alpha: number): string {
  return `rgba(${toRgbChannels(hex).replaceAll(' ', ', ')}, ${alpha})`;
}

/** HSL (hue in degrees, saturation and lightness in percent) → `#RRGGBB`. */
export function hsl(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): string => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

/** WCAG relative luminance of `#RRGGBB`. */
export function luminance(hex: string): number {
  const [r, g, b] = toRgbChannels(hex)
    .split(' ')
    .map((part) => {
      const c = Number(part) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#RRGGBB` colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A stable non-negative hash of a string, for picking a person's color. */
export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}
