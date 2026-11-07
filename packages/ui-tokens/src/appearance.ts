// What a user can change about how PingDost looks and feels (ADR 0035). Both apps show the same
// options and store them on the device: appearance is not synced and never leaves the device.
import { colorSchemes, schemeIds, type Palette, type SchemeId } from './schemes';

export interface Option<Id extends string = string> {
  id: Id;
  label: string;
  description?: string;
}

function options<const T extends readonly Option[]>(list: T): T {
  return list;
}

export const modeOptions = options([
  { id: 'system', label: 'Auto', description: 'Follows your device' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]);

export const lookOptions = options([
  { id: 'soft', label: 'Soft', description: 'Gentle shadows, no outlines' },
  { id: 'sticker', label: 'Sticker', description: 'Thick outlines, hard shadows' },
  { id: 'outline', label: 'Outline', description: 'Flat, with fine lines' },
]);

export const cornerOptions = options([
  { id: 'tight', label: 'Tight' },
  { id: 'round', label: 'Round' },
  { id: 'extra', label: 'Extra' },
]);

export const bubbleOptions = options([
  { id: 'round', label: 'Round' },
  { id: 'tail', label: 'Tail' },
  { id: 'squircle', label: 'Squircle' },
  { id: 'sharp', label: 'Sharp' },
]);

export const wallpaperOptions = options([
  { id: 'none', label: 'Plain' },
  { id: 'dots', label: 'Dots' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'grid', label: 'Grid' },
  { id: 'waves', label: 'Waves' },
  { id: 'confetti', label: 'Confetti' },
  { id: 'stars', label: 'Stars' },
]);

export const fontOptions = options([
  { id: 'pop', label: 'Pop', description: 'Bricolage Grotesque + Figtree' },
  { id: 'bubbly', label: 'Bubbly', description: 'Fredoka + Nunito' },
  { id: 'tech', label: 'Tech', description: 'Space Grotesk' },
  { id: 'system', label: 'System', description: 'Your device’s own font' },
]);

export const textSizeOptions = options([
  { id: 'sm', label: 'Small' },
  { id: 'md', label: 'Medium' },
  { id: 'lg', label: 'Large' },
  { id: 'xl', label: 'Huge' },
]);

export const densityOptions = options([
  { id: 'cozy', label: 'Cozy' },
  { id: 'compact', label: 'Compact' },
]);

export const avatarOptions = options([
  { id: 'squircle', label: 'Squircle' },
  { id: 'circle', label: 'Circle' },
]);

export const motionOptions = options([
  { id: 'full', label: 'Full', description: 'Springs, bursts and bounces' },
  { id: 'calm', label: 'Calm', description: 'Only gentle fades' },
  { id: 'off', label: 'Off', description: 'No animation at all' },
]);

type Ids<T extends readonly Option[]> = T[number]['id'];
export type Mode = Ids<typeof modeOptions>;
export type Look = Ids<typeof lookOptions>;
export type Corners = Ids<typeof cornerOptions>;
export type BubbleShape = Ids<typeof bubbleOptions>;
export type WallpaperId = Ids<typeof wallpaperOptions>;
export type FontId = Ids<typeof fontOptions>;
export type TextSize = Ids<typeof textSizeOptions>;
export type Density = Ids<typeof densityOptions>;
export type AvatarShape = Ids<typeof avatarOptions>;
export type Motion = Ids<typeof motionOptions>;

export interface AppearancePrefs {
  mode: Mode;
  /** OLED black in dark mode. */
  pureBlack: boolean;
  scheme: SchemeId;
  look: Look;
  corners: Corners;
  bubble: BubbleShape;
  wallpaper: WallpaperId;
  font: FontId;
  textSize: TextSize;
  density: Density;
  avatar: AvatarShape;
  motion: Motion;
  /** Vibration on key moments; phones only. */
  haptics: boolean;
}

export const defaultAppearance: AppearancePrefs = {
  mode: 'system',
  pureBlack: false,
  scheme: 'volt',
  look: 'soft',
  corners: 'round',
  bubble: 'round',
  wallpaper: 'dots',
  font: 'pop',
  textSize: 'md',
  density: 'cozy',
  avatar: 'squircle',
  motion: 'full',
  haptics: true,
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

const ids = <T extends readonly Option[]>(list: T) => list.map((o) => o.id) as Ids<T>[];

/** Whatever was stored, as valid prefs: unknown values (an older or newer build) get defaults. */
export function normalizeAppearance(stored: unknown): AppearancePrefs {
  const raw = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >;
  const d = defaultAppearance;
  return {
    mode: oneOf(raw.mode, ids(modeOptions), d.mode),
    pureBlack: typeof raw.pureBlack === 'boolean' ? raw.pureBlack : d.pureBlack,
    scheme: oneOf(raw.scheme, schemeIds, d.scheme),
    look: oneOf(raw.look, ids(lookOptions), d.look),
    corners: oneOf(raw.corners, ids(cornerOptions), d.corners),
    bubble: oneOf(raw.bubble, ids(bubbleOptions), d.bubble),
    wallpaper: oneOf(raw.wallpaper, ids(wallpaperOptions), d.wallpaper),
    font: oneOf(raw.font, ids(fontOptions), d.font),
    textSize: oneOf(raw.textSize, ids(textSizeOptions), d.textSize),
    density: oneOf(raw.density, ids(densityOptions), d.density),
    avatar: oneOf(raw.avatar, ids(avatarOptions), d.avatar),
    motion: oneOf(raw.motion, ids(motionOptions), d.motion),
    haptics: typeof raw.haptics === 'boolean' ? raw.haptics : d.haptics,
  };
}

/** Whether the app is in dark mode, given the device's own setting. */
export function isDark(prefs: Pick<AppearancePrefs, 'mode'>, deviceIsDark: boolean): boolean {
  return prefs.mode === 'system' ? deviceIsDark : prefs.mode === 'dark';
}

export const textScales: Record<TextSize, number> = { sm: 0.9, md: 1, lg: 1.12, xl: 1.28 };

export type RadiusName = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/** Corner radii, in density-independent pixels, for each "corners" setting. */
export const cornerRadii: Record<Corners, Record<RadiusName, number>> = {
  tight: { sm: 4, md: 8, lg: 10, xl: 14, '2xl': 18 },
  round: { sm: 10, md: 14, lg: 20, xl: 26, '2xl': 32 },
  extra: { sm: 14, md: 20, lg: 28, xl: 34, '2xl': 44 },
};

/** The radius of a default avatar: a circle, or a squircle at this share of its size. */
export function avatarRadius(shape: AvatarShape, size: number): number {
  return shape === 'circle' ? size / 2 : Math.round(size * 0.34);
}

export interface BubbleCorners {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

/**
 * A bubble's four corners. Messages from one sender in a row share a tight edge on the sender's
 * side, so a run reads as one group; `tail` pinches the last one.
 */
export function bubbleCorners(
  shape: BubbleShape,
  position: { outgoing: boolean; first: boolean; last: boolean },
): BubbleCorners {
  const big = { round: 22, tail: 20, squircle: 14, sharp: 4 }[shape];
  const tight = { round: 6, tail: 6, squircle: 6, sharp: 4 }[shape];
  const top = position.first ? big : tight;
  const bottom = position.last ? (shape === 'tail' ? 2 : big) : tight;
  return position.outgoing
    ? { topLeft: big, topRight: top, bottomLeft: big, bottomRight: bottom }
    : { topLeft: top, topRight: big, bottomLeft: bottom, bottomRight: big };
}

export interface SurfaceStyle {
  borderWidth: number;
  borderColor: string;
  /** A CSS box-shadow, or `none`. */
  boxShadow: string;
}

/** How a card or floating control sits on the page, for the chosen look. */
export function surfaceStyle(
  palette: Palette,
  look: Look,
  dark: boolean,
  raised = false,
): SurfaceStyle {
  switch (look) {
    case 'sticker':
      return {
        borderWidth: 2,
        borderColor: palette.foreground,
        boxShadow: `${raised ? 4 : 3}px ${raised ? 4 : 3}px 0px ${palette.foreground}`,
      };
    case 'outline':
      return { borderWidth: 1, borderColor: palette.border, boxShadow: 'none' };
    case 'soft':
      return {
        borderWidth: dark ? 1 : 0,
        borderColor: palette.border,
        boxShadow: dark
          ? 'none'
          : `0px ${raised ? 8 : 2}px ${raised ? 24 : 10}px rgba(20, 20, 40, ${raised ? 0.14 : 0.07})`,
      };
  }
}

/** The swatch colors of a scheme for its picker, in the mode the user is looking at. */
export function schemeSwatch(id: SchemeId, dark: boolean): { from: string; to: string } {
  const scheme = colorSchemes.find((entry) => entry.id === id) ?? colorSchemes[0];
  const seed = dark ? scheme.dark : scheme.light;
  return { from: seed.primary, to: seed.end };
}
