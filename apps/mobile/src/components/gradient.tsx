import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { usePalette } from '@/theme/theme-root';
import { brandGradient } from '@pingdost/ui-tokens';

interface GradientProps {
  children?: ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
  /** Two stops; the scheme's brand gradient by default. */
  colors?: readonly [string, string];
  angle?: number;
}

/** A view filled with a CSS gradient (a React Native style, no native module). */
export function Gradient({ children, className, style, colors, angle = 135 }: GradientProps) {
  const palette = usePalette();
  const backgroundImage = colors
    ? `linear-gradient(${angle}deg, ${colors[0]}, ${colors[1]})`
    : brandGradient(palette, angle);
  return (
    <View className={className} style={[{ backgroundImage }, style]}>
      {children}
    </View>
  );
}
