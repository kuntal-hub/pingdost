// The color schemes a user can pick (ADR 0035). A scheme is a seed per mode: a tint for the
// neutrals and the brand colors; `resolvePalette` derives the rest. `index.test.ts` checks every
// scheme in every mode against WCAG contrast, so a new one cannot ship unreadable.
import { hashString, hsl } from './color';

export const colorNames = [
  'background',
  'surface',
  'raised',
  'foreground',
  'muted',
  'border',
  'primary',
  'primary-end',
  'on-primary',
  'accent',
  'secondary',
  'on-secondary',
  'bubble-in',
  'on-bubble-in',
  'success',
  'warning',
  'danger',
  'on-danger',
] as const;

export type ColorName = (typeof colorNames)[number];
export type Palette = Record<ColorName, string>;

interface Seed {
  /** Hue and saturation of the neutrals. */
  tint: [number, number];
  /** A fill, with `on-primary` readable on the whole gradient to `end`. */
  primary: string;
  end: string;
  onPrimary: string;
  /** Brand color for text and icons directly on the background. */
  accent: string;
  secondary: string;
  onSecondary: string;
}

export interface ColorSchemeDefinition {
  id: string;
  name: string;
  /** Short, for the picker. */
  vibe: string;
  light: Seed;
  dark: Seed;
}

export const colorSchemes = [
  {
    id: 'volt',
    name: 'Volt',
    vibe: 'Electric lime, ultraviolet',
    light: {
      tint: [75, 22],
      primary: '#C6F135',
      end: '#8BE8A8',
      onPrimary: '#12170A',
      accent: '#4A2FD6',
      secondary: '#5B34EA',
      onSecondary: '#FFFFFF',
    },
    dark: {
      tint: [255, 14],
      primary: '#C8F53B',
      end: '#7DEBB0',
      onPrimary: '#0E1205',
      accent: '#C8F53B',
      secondary: '#A78BFA',
      onSecondary: '#140B33',
    },
  },
  {
    id: 'grape',
    name: 'Grape Soda',
    vibe: 'Fizzy violet into pink',
    light: {
      tint: [270, 30],
      primary: '#7C3AED',
      end: '#CF2E86',
      onPrimary: '#FFFFFF',
      accent: '#6D28D9',
      secondary: '#F59E0B',
      onSecondary: '#231500',
    },
    dark: {
      tint: [270, 22],
      primary: '#A78BFA',
      end: '#F472B6',
      onPrimary: '#16082E',
      accent: '#C4B5FD',
      secondary: '#FBBF24',
      onSecondary: '#231500',
    },
  },
  {
    id: 'bubblegum',
    name: 'Bubblegum',
    vibe: 'Hot pink, peach fuzz',
    light: {
      tint: [335, 45],
      primary: '#FF7AB8',
      end: '#FFB26B',
      onPrimary: '#2B0A1A',
      accent: '#BE1267',
      secondary: '#0B8FD6',
      onSecondary: '#001C2B',
    },
    dark: {
      tint: [335, 20],
      primary: '#FF7AB8',
      end: '#FFB26B',
      onPrimary: '#2B0A1A',
      accent: '#FF8CC6',
      secondary: '#5CC8FF',
      onSecondary: '#00212E',
    },
  },
  {
    id: 'mango',
    name: 'Mango',
    vibe: 'Golden, juicy, loud',
    light: {
      tint: [42, 45],
      primary: '#FFC400',
      end: '#FF9100',
      onPrimary: '#241100',
      accent: '#A8430A',
      secondary: '#0F766E',
      onSecondary: '#FFFFFF',
    },
    dark: {
      tint: [32, 18],
      primary: '#FFC400',
      end: '#FF9100',
      onPrimary: '#241100',
      accent: '#FFC43D',
      secondary: '#2DD4BF',
      onSecondary: '#03211D',
    },
  },
  {
    id: 'lagoon',
    name: 'Lagoon',
    vibe: 'Tropical teal to deep blue',
    light: {
      tint: [195, 35],
      primary: '#00C2D1',
      end: '#3D8BFF',
      onPrimary: '#03181F',
      accent: '#0B62B0',
      secondary: '#E8503F',
      onSecondary: '#200503',
    },
    dark: {
      tint: [205, 25],
      primary: '#22D3E6',
      end: '#3D8BFF',
      onPrimary: '#03181F',
      accent: '#4FD8E6',
      secondary: '#FF8A7A',
      onSecondary: '#2A0A06',
    },
  },
  {
    id: 'matcha',
    name: 'Matcha',
    vibe: 'Soft green, slow mornings',
    light: {
      tint: [80, 18],
      primary: '#A6CF4F',
      end: '#E3DC5A',
      onPrimary: '#172005',
      accent: '#3F6F18',
      secondary: '#C2356B',
      onSecondary: '#FFFFFF',
    },
    dark: {
      tint: [90, 12],
      primary: '#B5DC6A',
      end: '#E6DF6E',
      onPrimary: '#172005',
      accent: '#BCE06F',
      secondary: '#F08BB0',
      onSecondary: '#2A0813',
    },
  },
  {
    id: 'cherry',
    name: 'Cherry Cola',
    vibe: 'Glossy red, a bit dramatic',
    light: {
      tint: [350, 30],
      primary: '#D81B48',
      end: '#9F1239',
      onPrimary: '#FFFFFF',
      accent: '#BE123C',
      secondary: '#E0A800',
      onSecondary: '#211A00',
    },
    dark: {
      tint: [350, 18],
      primary: '#FB4B6E',
      end: '#FF8A5C',
      onPrimary: '#2A0409',
      accent: '#FF8197',
      secondary: '#FACC15',
      onSecondary: '#211A00',
    },
  },
  {
    id: 'galaxy',
    name: 'Galaxy',
    vibe: 'Indigo with a blue streak',
    light: {
      tint: [235, 35],
      primary: '#4F46E5',
      end: '#2563EB',
      onPrimary: '#FFFFFF',
      accent: '#3F37C9',
      secondary: '#0E7490',
      onSecondary: '#FFFFFF',
    },
    dark: {
      tint: [235, 28],
      primary: '#818CF8',
      end: '#38BDF8',
      onPrimary: '#060B26',
      accent: '#A5B4FC',
      secondary: '#22D3EE',
      onSecondary: '#04202A',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    vibe: 'Coral melting into gold',
    light: {
      tint: [15, 40],
      primary: '#FF6B6B',
      end: '#FFC371',
      onPrimary: '#2B0E05',
      accent: '#BF360C',
      secondary: '#6D3BD6',
      onSecondary: '#FFFFFF',
    },
    dark: {
      tint: [15, 18],
      primary: '#FF7B7B',
      end: '#FFC371',
      onPrimary: '#2B0E05',
      accent: '#FFA58C',
      secondary: '#B79BFF',
      onSecondary: '#160A33',
    },
  },
  {
    id: 'mono',
    name: 'Mono',
    vibe: 'Black, white, nothing else',
    light: {
      tint: [0, 0],
      primary: '#111111',
      end: '#3A3A3A',
      onPrimary: '#FFFFFF',
      accent: '#111111',
      secondary: '#555555',
      onSecondary: '#FFFFFF',
    },
    dark: {
      tint: [0, 0],
      primary: '#F5F5F5',
      end: '#C9C9C9',
      onPrimary: '#0A0A0A',
      accent: '#F5F5F5',
      secondary: '#A3A3A3',
      onSecondary: '#0A0A0A',
    },
  },
] as const satisfies readonly ColorSchemeDefinition[];

export type SchemeId = (typeof colorSchemes)[number]['id'];

export const schemeIds = colorSchemes.map<SchemeId>((scheme) => scheme.id);

/** Every color of one scheme in one mode. `pureBlack` is the OLED variant of dark. */
export function resolvePalette(scheme: SchemeId, dark: boolean, pureBlack = false): Palette {
  const definition = colorSchemes.find((entry) => entry.id === scheme) ?? colorSchemes[0];
  const seed: Seed = dark ? definition.dark : definition.light;
  const [h, s] = seed.tint;
  const brand = {
    primary: seed.primary,
    'primary-end': seed.end,
    'on-primary': seed.onPrimary,
    accent: seed.accent,
    secondary: seed.secondary,
    'on-secondary': seed.onSecondary,
  };
  if (!dark) {
    const foreground = hsl(h, Math.min(s, 30), 9);
    return {
      background: hsl(h, s, 96),
      surface: hsl(h, Math.min(s, 60), 99.5),
      raised: hsl(h, s, 91),
      foreground,
      muted: hsl(h, Math.min(s, 14), 35),
      border: hsl(h, s, 85),
      ...brand,
      'bubble-in': hsl(h, Math.min(s, 60), 99.5),
      'on-bubble-in': foreground,
      success: '#11723A',
      warning: '#8F5600',
      danger: '#C01C1C',
      'on-danger': '#FFFFFF',
    };
  }
  const foreground = hsl(h, Math.min(s, 20), 96);
  const surface = hsl(h, s, pureBlack ? 7 : 10);
  return {
    background: pureBlack ? '#000000' : hsl(h, s, 6),
    surface,
    raised: hsl(h, s, pureBlack ? 12 : 15),
    foreground,
    muted: hsl(h, Math.min(s, 12), 68),
    border: hsl(h, s, pureBlack ? 16 : 20),
    ...brand,
    'bubble-in': hsl(h, s, pureBlack ? 12 : 15),
    'on-bubble-in': foreground,
    success: '#4ADE80',
    warning: '#FACC15',
    danger: '#FF6B6B',
    'on-danger': '#2A0505',
  };
}

/** The CSS gradient of the brand fill: outgoing bubbles, primary buttons, the active tab. */
export function brandGradient(palette: Palette, angle = 135): string {
  return `linear-gradient(${angle}deg, ${palette.primary}, ${palette['primary-end']})`;
}

// People keep their color whatever scheme is on, so a face stays recognizable.
const AVATAR_COLORS: readonly (readonly [string, string, string])[] = [
  ['#FF8A65', '#FF5277', '#2B0612'],
  ['#8E7BFF', '#C77DFF', '#14082E'],
  ['#48D6C4', '#3FA9F5', '#04181F'],
  ['#FFD25F', '#FF9F45', '#2A1500'],
  ['#9BE15D', '#3DD6A0', '#08200F'],
  ['#FF9BD2', '#FF7AA2', '#2E0719'],
  ['#6FB1FF', '#7A8CFF', '#07142E'],
  ['#E8E25A', '#9BE15D', '#1A1F03'],
];

/** The two gradient stops and the readable initials color of a person's default avatar. */
export function avatarColors(seed: string): { from: string; to: string; on: string } {
  const [from, to, on] = AVATAR_COLORS[hashString(seed) % AVATAR_COLORS.length]!;
  return { from, to, on };
}

/** A group member's name above their messages, readable on an incoming bubble. */
export function senderColor(userId: string, dark: boolean): string {
  const hue = hashString(userId) % 360;
  return dark ? hsl(hue, 85, 74) : hsl(hue, 80, 27);
}
