import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { vars } from 'nativewind';
import type { ReactNode } from 'react';
import { useColorScheme, View } from 'react-native';

import { colorVariables, palettes, type ColorScheme } from '@pingdost/ui-tokens';

// NativeWind classes such as `bg-surface` read these variables (see tailwind.config.js).
const themeVariables = {
  light: vars(colorVariables('light')),
  dark: vars(colorVariables('dark')),
};

function navigationTheme(scheme: ColorScheme) {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const palette = palettes[scheme];
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.primary,
      background: palette.background,
      card: palette.surface,
      text: palette.foreground,
      border: palette.border,
      notification: palette.danger,
    },
  };
}

/** Follows the system light/dark setting for NativeWind classes and navigation chrome. */
export function ThemeRoot({ children }: { children: ReactNode }) {
  const scheme: ColorScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return (
    <ThemeProvider value={navigationTheme(scheme)}>
      <View style={themeVariables[scheme]} className="flex-1 bg-background">
        {children}
      </View>
    </ThemeProvider>
  );
}
