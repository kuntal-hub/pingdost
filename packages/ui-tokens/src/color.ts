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

/** `fg` drawn at `alpha` over `bg`, as the opaque `#RRGGBB` the eye sees. */
export function mix(fg: string, bg: string, alpha: number): string {
  const front = toRgbChannels(fg).split(' ').map(Number);
  const back = toRgbChannels(bg).split(' ').map(Number);
  return `#${front
    .map((value, i) =>
      Math.round(value * alpha + back[i]! * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase();
}

/** CIE L*a*b* (D65) of `#RRGGBB`. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = toRgbChannels(hex)
    .split(' ')
    .map((part) => {
      const c = Number(part) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * How different two colors look (CIE76 ΔE). About 2 is just noticeable; 30 and more reads as
 * a different color at a glance, even at icon size.
 */
export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** A stable non-negative hash of a string, for picking a person's color. */
export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}
