import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { useTheme } from '@/theme/theme-root';
import { wallpaperSvg, type WallpaperId } from '@pingdost/ui-tokens';

/** The chat wallpaper, behind the messages; decorative. */
export function Wallpaper({ id }: { id?: WallpaperId }) {
  const { palette, dark, prefs } = useTheme();
  const wallpaper = id ?? prefs.wallpaper;
  const xml = useMemo(() => wallpaperSvg(wallpaper, palette, dark), [wallpaper, palette, dark]);
  if (!xml) return null;
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <SvgXml xml={xml} width="100%" height="100%" />
    </View>
  );
}
