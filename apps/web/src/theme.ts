// The user's appearance (ADR 0035), applied as CSS variables through the CSSOM (allowed by the
// strict CSP, unlike an inline <style>). Kept in this browser's localStorage: it is a per-browser
// convenience, not synced, and the app looks right without it.
import { create } from 'zustand';

import {
  colorNames,
  cornerRadii,
  defaultAppearance,
  isDark,
  normalizeAppearance,
  resolvePalette,
  surfaceStyle,
  textScales,
  toRgbChannels,
  wallpaperSvg,
  type AppearancePrefs,
  type FontId,
  type Palette,
} from '@pingdost/ui-tokens';

const STORAGE_KEY = 'pingdost.appearance';

const SYSTEM_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";

const FONTS: Record<FontId, { body: string; display: string }> = {
  pop: {
    body: `'Figtree Variable', ${SYSTEM_FONT}`,
    display: `'Bricolage Grotesque Variable', ${SYSTEM_FONT}`,
  },
  bubbly: {
    body: `'Nunito Variable', ${SYSTEM_FONT}`,
    display: `'Fredoka Variable', ${SYSTEM_FONT}`,
  },
  tech: {
    body: `'Space Grotesk Variable', ${SYSTEM_FONT}`,
    display: `'Space Grotesk Variable', ${SYSTEM_FONT}`,
  },
  system: { body: SYSTEM_FONT, display: SYSTEM_FONT },
};

/** The display font of a choice, for its tile in Appearance. */
export function displayFont(font: FontId): string {
  return FONTS[font].display;
}

function read(): AppearancePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeAppearance(JSON.parse(raw)) : defaultAppearance;
  } catch {
    return defaultAppearance;
  }
}

function write(prefs: AppearancePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A private window or blocked storage: it just will not be remembered.
  }
}

const deviceDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function themeVariables(prefs: AppearancePrefs, dark: boolean): Record<string, string> {
  const palette = resolvePalette(prefs.scheme, dark, prefs.pureBlack);
  const radii = cornerRadii[prefs.corners];
  const card = surfaceStyle(palette, prefs.look, dark);
  const floating = surfaceStyle(palette, prefs.look, dark, true);
  const wallpaper = wallpaperSvg(prefs.wallpaper, palette, dark);
  return {
    ...Object.fromEntries(colorNames.map((name) => [`--pd-${name}`, toRgbChannels(palette[name])])),
    '--pd-radius-sm': `${radii.sm}px`,
    '--pd-radius-md': `${radii.md}px`,
    '--pd-radius-lg': `${radii.lg}px`,
    '--pd-radius-xl': `${radii.xl}px`,
    '--pd-radius-2xl': `${radii['2xl']}px`,
    '--pd-font-body': FONTS[prefs.font].body,
    '--pd-font-display': FONTS[prefs.font].display,
    '--pd-text-scale': String(textScales[prefs.textSize]),
    '--pd-card-border-width': `${card.borderWidth}px`,
    '--pd-card-border-color': card.borderColor,
    '--pd-card-shadow': card.boxShadow,
    '--pd-floating-border-width': `${floating.borderWidth}px`,
    '--pd-floating-border-color': floating.borderColor,
    '--pd-floating-shadow': floating.boxShadow,
    '--pd-wallpaper': wallpaper
      ? `url("data:image/svg+xml,${encodeURIComponent(wallpaper)}")`
      : 'none',
  };
}

function apply(prefs: AppearancePrefs, dark: boolean): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(prefs, dark))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.look = prefs.look;
  root.dataset.density = prefs.density;
  root.dataset.motion = prefs.motion === 'full' && reducedMotion() ? 'calm' : prefs.motion;
  const palette = resolvePalette(prefs.scheme, dark, prefs.pureBlack);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.background);
}

interface AppearanceState {
  prefs: AppearancePrefs;
  dark: boolean;
  palette: Palette;
  update: (patch: Partial<AppearancePrefs>) => void;
  reset: () => void;
}

/** The change spreads out from where the user clicked, in browsers that can do it. */
function withReveal(change: () => void): void {
  const motion = document.documentElement.dataset.motion;
  if (motion === 'full' && 'startViewTransition' in document) {
    void document.startViewTransition(change);
  } else {
    change();
  }
}

function derived(prefs: AppearancePrefs): Pick<AppearanceState, 'prefs' | 'dark' | 'palette'> {
  const dark = isDark(prefs, deviceDark());
  return { prefs, dark, palette: resolvePalette(prefs.scheme, dark, prefs.pureBlack) };
}

export const useAppearance = create<AppearanceState>((set, get) => {
  // The store changes at once, so quick successive choices build on each other. A view transition
  // runs its callback later, so the repaint reads whatever is current by then.
  const repaint = () => {
    const { prefs, dark } = get();
    apply(prefs, dark);
  };
  const change = (prefs: AppearancePrefs, reveal: boolean) => {
    write(prefs);
    set(derived(prefs));
    if (reveal) withReveal(repaint);
    else repaint();
  };
  return {
    ...derived(read()),
    update(patch) {
      const reveal = 'mode' in patch || 'scheme' in patch || 'pureBlack' in patch;
      change({ ...get().prefs, ...patch }, reveal);
    },
    reset() {
      change(defaultAppearance, true);
    },
  };
});

/** Applies the saved appearance now, and follows the device when set to Auto. */
export function installTheme(): void {
  const { prefs, dark } = useAppearance.getState();
  apply(prefs, dark);
  const refresh = () => {
    const next = derived(useAppearance.getState().prefs);
    apply(next.prefs, next.dark);
    useAppearance.setState(next);
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', refresh);
  // Remembers where the last click was, for the reveal.
  window.addEventListener('pointerdown', (event) => {
    const root = document.documentElement;
    root.style.setProperty('--pd-vt-x', `${event.clientX}px`);
    root.style.setProperty('--pd-vt-y', `${event.clientY}px`);
  });
}
