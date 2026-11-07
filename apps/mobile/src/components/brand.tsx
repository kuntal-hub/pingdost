import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import { CSS_EASE_IN_OUT, CSS_EASE_OUT, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';

import { Gradient } from './gradient';

const RING = {
  from: { transform: [{ scale: 0.9 }], opacity: 0.55 },
  to: { transform: [{ scale: 1.5 }], opacity: 0 },
};

const BOB = {
  from: { transform: [{ translateY: -6 }, { rotate: '-5deg' }] },
  to: { transform: [{ translateY: 6 }, { rotate: '5deg' }] },
};

/** The PingDost mark: a speech bubble with a dot, sending out a ping. */
export function BrandMark({ size = 96, animated = true }: { size?: number; animated?: boolean }) {
  const { palette } = useTheme();
  const { moves } = useMotion();
  const live = animated && moves;
  const radius = Math.round(size * 0.32);
  return (
    <View
      className="items-center justify-center"
      style={{ width: size, height: size }}
      importantForAccessibility="no-hide-descendants"
    >
      {live && (
        <Animated.View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: radius,
            borderWidth: 3,
            borderColor: palette.accent,
            animationName: RING,
            animationDuration: 2000,
            animationIterationCount: 'infinite',
            animationTimingFunction: CSS_EASE_OUT,
          }}
        />
      )}
      <Animated.View
        style={
          live
            ? {
                animationName: BOB,
                animationDuration: 2400,
                animationIterationCount: 'infinite',
                animationDirection: 'alternate',
                animationTimingFunction: CSS_EASE_IN_OUT,
              }
            : undefined
        }
      >
        <Gradient
          className="items-center justify-center"
          style={{ width: size, height: size, borderRadius: radius }}
        >
          <Svg width={size * 0.62} height={size * 0.62} viewBox="0 0 48 48">
            <Path
              d="M24 5C12.4 5 3 13 3 22.8c0 5.4 2.9 10.2 7.4 13.5L8.6 44l8.8-4.5c2.1.5 4.3.8 6.6.8 11.6 0 21-8 21-17.5S35.6 5 24 5Z"
              fill={palette['on-primary']}
            />
            <Circle cx="24" cy="22.8" r="6.5" fill={palette.primary} />
          </Svg>
        </Gradient>
      </Animated.View>
    </View>
  );
}
