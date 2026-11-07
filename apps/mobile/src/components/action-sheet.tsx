import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, useWindowDimensions, View } from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { EASE_OUT, haptic, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';

import { Icon, type LucideIcon } from './icon';
import { Tap } from './tap';
import { Text } from './text';

export interface SheetAction {
  label: string;
  /** Shown under the label, e.g. what a delete really does. */
  detail?: string;
  destructive?: boolean;
  icon?: LucideIcon;
  onPress: () => void;
}

interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  /** Above the actions, e.g. a row of reactions. */
  header?: ReactNode;
  actions: SheetAction[];
  /** Big tiles side by side, for a few equal choices such as what to attach. */
  layout?: 'list' | 'tiles';
}

/** Where a flick would come to rest: lets a quick short swipe dismiss. */
function project(velocity: number): number {
  'worklet';
  return (velocity / 1000) * (0.998 / (1 - 0.998));
}

/**
 * A bottom sheet of actions (long-press menus). It springs up, follows the finger and dismisses
 * on a flick or a long drag. Choosing an action closes the sheet first.
 */
export function ActionSheet({
  visible,
  onClose,
  title,
  header,
  actions,
  layout = 'list',
}: ActionSheetProps) {
  const insets = useSafeAreaInsets();
  const { palette, floating } = useTheme();
  const { moves, fades } = useMotion();
  const { height: windowHeight } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const y = useSharedValue(windowHeight);
  const start = useSharedValue(0);
  const sheetHeight = useSharedValue(windowHeight);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (!fades) {
      setMounted(false);
      return;
    }
    y.set(
      withTiming(sheetHeight.get(), { duration: 200, easing: EASE_OUT }, (finished) => {
        if (finished) scheduleOnRN(setMounted, false);
      }),
    );
    // `mounted` must not retrigger this: only a change of `visible` starts the way out.
  }, [visible, fades]);

  const pan = usePanGesture({
    activeOffsetY: [-8, 8],
    onActivate: () => {
      'worklet';
      start.set(y.get());
    },
    onUpdate: (event) => {
      'worklet';
      const next = start.get() + event.translationY;
      // Upward resists: the sheet has nowhere to go.
      y.set(next >= 0 ? next : next * 0.15);
    },
    onDeactivate: (event) => {
      'worklet';
      const projected = y.get() + project(event.velocityY);
      if (projected > sheetHeight.get() * 0.45) {
        y.set(
          withSpring(
            sheetHeight.get(),
            { duration: 240, dampingRatio: 1, velocity: event.velocityY, overshootClamping: true },
            (finished) => {
              if (finished) scheduleOnRN(onClose);
            },
          ),
        );
      } else {
        y.set(withSpring(0, { duration: 300, dampingRatio: 0.85, velocity: event.velocityY }));
      }
    },
  });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [0, sheetHeight.get()], [1, 0], Extrapolation.CLAMP),
  }));

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="none"
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View
          style={[
            { position: 'absolute', inset: 0, backgroundColor: 'rgba(5, 5, 15, 0.55)' },
            backdropStyle,
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={{ flex: 1 }}
          />
        </Animated.View>
        <View className="flex-1 justify-end" pointerEvents="box-none">
          <GestureDetector gesture={pan}>
            <Animated.View
              onLayout={(event) => {
                const { height } = event.nativeEvent.layout;
                sheetHeight.set(height);
                if (!visible) return;
                if (moves) {
                  y.set(height);
                  y.set(withSpring(0, { duration: 340, dampingRatio: 0.82 }));
                } else if (fades) {
                  y.set(withTiming(0, { duration: 160, easing: EASE_OUT }));
                } else {
                  y.set(0);
                }
              }}
              style={[
                {
                  marginHorizontal: 8,
                  marginBottom: Math.max(insets.bottom, 8),
                  backgroundColor: palette.surface,
                  ...floating,
                },
                sheetStyle,
              ]}
              className="gap-1 rounded-2xl px-2 pb-2"
            >
              <View className="items-center py-3" importantForAccessibility="no">
                <View className="h-1 w-10 rounded-full bg-border" />
              </View>
              {title && (
                <Text numberOfLines={2} className="px-3 pb-2 text-center font-semibold text-muted">
                  {title}
                </Text>
              )}
              {header}
              {layout === 'tiles' ? (
                <View className="flex-row flex-wrap justify-center gap-2 p-2">
                  {actions.map((action) => (
                    <Tap
                      key={action.label}
                      accessibilityLabel={
                        action.detail ? `${action.label}. ${action.detail}` : action.label
                      }
                      feedback="selection"
                      onPress={() => {
                        onClose();
                        action.onPress();
                      }}
                      className="min-w-[44%] flex-1 items-center gap-2 rounded-xl bg-raised p-4"
                    >
                      {action.icon && (
                        <View className="h-12 w-12 items-center justify-center rounded-full bg-accent/15">
                          <Icon icon={action.icon} size={24} color="accent" />
                        </View>
                      )}
                      <Text className="text-center font-bold text-foreground">{action.label}</Text>
                      {action.detail && (
                        <Text className="text-center text-xs text-muted">{action.detail}</Text>
                      )}
                    </Tap>
                  ))}
                </View>
              ) : (
                actions.map((action) => (
                  <Pressable
                    key={action.label}
                    accessibilityRole="button"
                    accessibilityLabel={
                      action.detail ? `${action.label}. ${action.detail}` : action.label
                    }
                    onPress={() => {
                      if (action.destructive) haptic('medium');
                      onClose();
                      action.onPress();
                    }}
                    className="min-h-[52px] flex-row items-center gap-3 rounded-lg px-3 py-3 active:bg-raised"
                  >
                    {action.icon && (
                      <Icon
                        icon={action.icon}
                        size={22}
                        color={action.destructive ? 'danger' : 'foreground'}
                      />
                    )}
                    <View className="flex-1">
                      <Text
                        className={`text-base font-semibold ${action.destructive ? 'text-danger' : 'text-foreground'}`}
                      >
                        {action.label}
                      </Text>
                      {action.detail && <Text className="text-muted">{action.detail}</Text>}
                    </View>
                  </Pressable>
                ))
              )}
              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                className="min-h-[52px] items-center justify-center rounded-lg active:bg-raised"
              >
                <Text className="text-base font-bold text-muted">Cancel</Text>
              </Pressable>
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
