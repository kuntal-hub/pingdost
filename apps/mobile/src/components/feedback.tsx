// Loading and empty states, and the little animated things that say "something is happening".
import type { ReactNode } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { CSS_EASE_IN_OUT, useMotion } from '@/theme/motion';
import { usePalette } from '@/theme/theme-root';

import { Icon, type LucideIcon } from './icon';
import { Text } from './text';

const FLOAT = {
  from: { transform: [{ translateY: -4 }, { rotate: '-4deg' }] },
  to: { transform: [{ translateY: 4 }, { rotate: '4deg' }] },
};

const PULSE = { from: { opacity: 0.45 }, to: { opacity: 1 } };

const BOUNCE = {
  '0%': { transform: [{ translateY: 0 }], opacity: 0.45 },
  '30%': { transform: [{ translateY: -5 }], opacity: 1 },
  '60%': { transform: [{ translateY: 0 }], opacity: 0.45 },
  '100%': { transform: [{ translateY: 0 }], opacity: 0.45 },
};

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  message?: string;
  children?: ReactNode;
}

/** What a list says when it has nothing in it, with its icon gently floating. */
export function EmptyState({ icon, title, message, children }: EmptyStateProps) {
  const { moves } = useMotion();
  return (
    <View className="items-center gap-3 px-6 py-10">
      <Animated.View
        className="h-[88px] w-[88px] items-center justify-center rounded-2xl bg-accent/15"
        style={
          moves
            ? {
                animationName: FLOAT,
                animationDuration: 2600,
                animationIterationCount: 'infinite',
                animationDirection: 'alternate',
                animationTimingFunction: CSS_EASE_IN_OUT,
              }
            : undefined
        }
      >
        <Icon icon={icon} size={40} color="accent" />
      </Animated.View>
      <Text
        accessibilityRole="header"
        className="text-center font-display text-2xl text-foreground"
      >
        {title}
      </Text>
      {message && <Text className="text-center text-base text-muted">{message}</Text>}
      {children}
    </View>
  );
}

/** Placeholder rows while a list loads, so it does not blink through "No items". */
export function SkeletonRows({ count = 6 }: { count?: number }) {
  const { fades } = useMotion();
  return (
    <Animated.View
      accessible
      accessibilityLabel="Loading"
      className="gap-4 px-5 py-3"
      style={
        fades
          ? {
              animationName: PULSE,
              animationDuration: 900,
              animationIterationCount: 'infinite',
              animationDirection: 'alternate',
              animationTimingFunction: CSS_EASE_IN_OUT,
            }
          : undefined
      }
    >
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="flex-row items-center gap-3" importantForAccessibility="no">
          <View className="h-[52px] w-[52px] rounded-lg bg-raised" />
          <View className="flex-1 gap-2">
            <View className="h-3 rounded-full bg-raised" style={{ width: `${60 - index * 6}%` }} />
            <View className="h-3 rounded-full bg-raised" style={{ width: `${90 - index * 8}%` }} />
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

/** Three bouncing dots: someone is typing. */
export function TypingDots({ color = 'muted' }: { color?: 'muted' | 'on-primary' | 'foreground' }) {
  const palette = usePalette();
  const { moves } = useMotion();
  return (
    <View className="h-4 flex-row items-center gap-1" importantForAccessibility="no">
      {[0, 160, 320].map((delay) => (
        <Animated.View
          key={delay}
          className="h-2 w-2 rounded-full"
          style={{
            backgroundColor: palette[color],
            ...(moves
              ? {
                  animationName: BOUNCE,
                  animationDuration: 1100,
                  animationDelay: delay,
                  animationIterationCount: 'infinite',
                  animationTimingFunction: CSS_EASE_IN_OUT,
                }
              : {}),
          }}
        />
      ))}
    </View>
  );
}
