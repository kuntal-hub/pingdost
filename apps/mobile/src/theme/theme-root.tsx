import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SystemUI from 'expo-system-ui';
import { vars } from 'nativewind';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Appearance, useColorScheme, View } from 'react-native';

import {
  colorVariables,
  isDark,
  radiusVariables,
  resolvePalette,
  surfaceStyle,
  type AppearancePrefs,
  type Palette,
  type SurfaceStyle,
} from '@pingdost/ui-tokens';

import { useAppearance } from './appearance';
import { fontFamily, loadFont, useLoadedFonts } from './fonts';

export interface Theme {
  palette: Palette;
  dark: boolean;
  prefs: AppearancePrefs;
  /** How a card sits on the page, for the chosen look. */
  card: SurfaceStyle;
  /** The same for something floating above the page: tab bar, composer, sheet. */
  floating: SurfaceStyle;
}

const ThemeContext = createContext<Theme | undefined>(undefined);

function navigationTheme(palette: Palette, dark: boolean, prefs: AppearancePrefs, ready: boolean) {
  const base = dark ? DarkTheme : DefaultTheme;
  const font = (weight: 400 | 600 | 700 | 'display', fallback: { fontWeight: string }) => {
    const family = ready ? fontFamily(prefs.font, weight) : undefined;
    return (
      family ? { fontFamily: family, fontWeight: '400' } : fallback
    ) as typeof base.fonts.regular;
  };
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.accent,
      background: palette.background,
      card: palette.background,
      text: palette.foreground,
      border: palette.border,
      notification: palette.danger,
    },
    fonts: {
      regular: font(400, base.fonts.regular),
      medium: font(600, base.fonts.medium),
      bold: font('display', base.fonts.bold),
      heavy: font('display', base.fonts.heavy),
    },
  };
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme outside ThemeRoot');
  return theme;
}

/** The current palette, for props that take a color value (placeholders, spinners, icons). */
export function usePalette(): Palette {
  return useTheme().palette;
}

/** The user's appearance as NativeWind variables, navigation chrome and system bars. */
export function ThemeRoot({ children }: { children: ReactNode }) {
  const prefs = useAppearance((state) => state.prefs);
  const fontReady = useLoadedFonts((state) => state.loaded.includes(prefs.font));
  const device = useColorScheme();

  // Native controls, the keyboard and system bars follow the setting too.
  useEffect(() => {
    Appearance.setColorScheme(prefs.mode === 'system' ? 'unspecified' : prefs.mode);
  }, [prefs.mode]);

  useEffect(() => {
    void loadFont(prefs.font);
  }, [prefs.font]);

  const dark = isDark(prefs, device === 'dark');
  const palette = useMemo(
    () => resolvePalette(prefs.scheme, dark, prefs.pureBlack),
    [prefs.scheme, dark, prefs.pureBlack],
  );

  // What shows behind screens during transitions and under the keyboard.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(palette.background).catch(() => undefined);
  }, [palette.background]);

  const variables = useMemo(
    () => vars({ ...colorVariables(palette), ...radiusVariables(prefs.corners) }),
    [palette, prefs.corners],
  );
  const navigation = useMemo(
    () => navigationTheme(palette, dark, prefs, fontReady),
    [palette, dark, prefs, fontReady],
  );
  const theme = useMemo<Theme>(
    () => ({
      palette,
      dark,
      prefs,
      card: surfaceStyle(palette, prefs.look, dark),
      floating: surfaceStyle(palette, prefs.look, dark, true),
    }),
    [palette, dark, prefs],
  );

  return (
    <ThemeContext.Provider value={theme}>
      <ThemeProvider value={navigation}>
        <View style={variables} className="flex-1 bg-background">
          {children}
        </View>
      </ThemeProvider>
    </ThemeContext.Provider>
  );
}
