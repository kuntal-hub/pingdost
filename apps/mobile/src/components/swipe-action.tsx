import type { ReactNode } from 'react';
import { View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { haptic, useMotion } from '@/theme/motion';
import type { ColorName } from '@pingdost/ui-tokens';

import { Icon, type LucideIcon } from './icon';

/** How far to drag before letting go commits. */
const COMMIT = 72;
const MAX = 110;

export interface SwipeSide {
  icon: LucideIcon;
  onCommit: () => void;
  color?: ColorName;
}

interface SwipeActionProps {
  children: ReactNode;
  /** Revealed by swiping right. */
  left?: SwipeSide;
  /** Revealed by swiping left. */
  right?: SwipeSide;
  enabled?: boolean;
}

/**
 * Drag a row sideways to reveal an action, past the line to commit it. The row always springs
 * back. Declaring the horizontal axis keeps the list's vertical scroll free. Screen readers
 * reach the same actions from the long-press sheet.
 */
export function SwipeAction({ children, left, right, enabled = true }: SwipeActionProps) {
  const { moves } = useMotion();
  const x = useSharedValue(0);
  const canLeft = left !== undefined;
  const canRight = right !== undefined;

  const commit = (side: SwipeSide | undefined) => {
    haptic('light');
    side?.onCommit();
  };

  const pan = usePanGesture({
    enabled: enabled && (canLeft || canRight),
    activeOffsetX: [-16, 16],
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      'worklet';
      const next = event.translationX;
      if ((next > 0 && !canLeft) || (next < 0 && !canRight)) {
        x.set(0);
        return;
      }
      // The further past the line, the less it follows.
      const magnitude = Math.abs(next);
      const eased = magnitude <= COMMIT ? magnitude : COMMIT + (magnitude - COMMIT) * 0.35;
      x.set(Math.sign(next) * Math.min(eased, MAX));
    },
    onDeactivate: (event) => {
      'worklet';
      const at = x.get();
      if (at >= COMMIT) scheduleOnRN(commit, left);
      else if (at <= -COMMIT) scheduleOnRN(commit, right);
      x.set(withSpring(0, { duration: 320, dampingRatio: 0.8, velocity: event.velocityX }));
    },
  });

  // A tick as the row crosses the line, in either direction.
  useAnimatedReaction(
    () => Math.abs(x.get()) >= COMMIT,
    (armed, wasArmed) => {
      if (wasArmed !== null && armed !== wasArmed) scheduleOnRN(haptic, 'selection');
    },
  );

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const leftStyle = useAnimatedStyle(() => {
    const progress = interpolate(x.get(), [8, COMMIT], [0, 1], Extrapolation.CLAMP);
    return { opacity: progress, transform: [{ scale: 0.6 + progress * 0.5 }] };
  });
  const rightStyle = useAnimatedStyle(() => {
    const progress = interpolate(x.get(), [-COMMIT, -8], [1, 0], Extrapolation.CLAMP);
    return { opacity: progress, transform: [{ scale: 0.6 + progress * 0.5 }] };
  });

  // The tree stays the same when a row loses its actions (a message deleted for everyone while
  // on screen), so its content is updated in place rather than mounted again.
  if (!moves) return <View>{children}</View>;

  return (
    <View>
      {left && (
        <Animated.View
          className="absolute bottom-0 left-5 top-0 justify-center"
          style={leftStyle}
          importantForAccessibility="no"
        >
          <View className="h-10 w-10 items-center justify-center rounded-full bg-accent/20">
            <Icon icon={left.icon} size={20} color={left.color ?? 'accent'} />
          </View>
        </Animated.View>
      )}
      {right && (
        <Animated.View
          className="absolute bottom-0 right-5 top-0 justify-center"
          style={rightStyle}
          importantForAccessibility="no"
        >
          <View className="h-10 w-10 items-center justify-center rounded-full bg-accent/20">
            <Icon icon={right.icon} size={20} color={right.color ?? 'accent'} />
          </View>
        </Animated.View>
      )}
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}
