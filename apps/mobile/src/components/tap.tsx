import { cssInterop } from 'nativewind';
import { useState, type ComponentProps } from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { CSS_EASE_OUT, haptic, useMotion } from '@/theme/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
cssInterop(AnimatedPressable, { className: 'style' });

type HapticKind = Parameters<typeof haptic>[0];

export interface TapProps extends Omit<ComponentProps<typeof Pressable>, 'style' | 'children'> {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  className?: string;
  /** How far it shrinks under a finger. */
  scaleTo?: number;
  /** Fired with the press, so the feedback lands with the visual. */
  feedback?: HapticKind;
}

/**
 * The pressable for button-like things: it shrinks on touch, in 120 ms on the UI thread, or dims
 * if motion is off. Full-width rows highlight instead (`active:bg-raised`).
 */
export function Tap({
  scaleTo = 0.96,
  feedback,
  onPress,
  onPressIn,
  onPressOut,
  style,
  accessibilityRole = 'button',
  ...props
}: TapProps) {
  const [pressed, setPressed] = useState(false);
  const { moves } = useMotion();
  return (
    <AnimatedPressable
      accessibilityRole={accessibilityRole}
      pressRetentionOffset={16}
      onPress={(event) => {
        if (feedback) haptic(feedback);
        onPress?.(event);
      }}
      onPressIn={(event) => {
        setPressed(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        onPressOut?.(event);
      }}
      style={[
        {
          transform: [{ scale: pressed && moves ? scaleTo : 1 }],
          opacity: pressed && !moves ? 0.7 : 1,
          transitionProperty: ['transform', 'opacity'],
          transitionDuration: 120,
          transitionTimingFunction: CSS_EASE_OUT,
        },
        style,
      ]}
      {...props}
    />
  );
}
