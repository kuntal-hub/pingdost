// The small picture in a video call (usually the user's own camera): it can be dragged anywhere
// and settles in the nearest corner, the way the flick points. A tap swaps it with the big one.
// It stays clear of the controls: `top` and `bottom` are the free band, and it follows them
// when the controls show or hide.
import { useEffect } from 'react';
import { Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { RTCView } from 'react-native-webrtc';

import { haptic, useMotion } from '@/theme/motion';

const WIDTH = 110;
const HEIGHT = 160;
const MARGIN = 16;

export function SelfView({
  streamURL,
  mirror,
  label,
  canSwap,
  onSwap,
  top,
  bottom,
}: {
  streamURL: string;
  mirror: boolean;
  label: string;
  canSwap: boolean;
  onSwap: () => void;
  /** The free band for the picture, from the top of the screen. */
  top: number;
  /** Space kept free at the bottom (the controls). */
  bottom: number;
}) {
  const { width, height } = useWindowDimensions();
  const { moves } = useMotion();
  const left = MARGIN;
  const right = width - WIDTH - MARGIN;
  const upper = top;
  const lower = Math.max(top, height - bottom - HEIGHT);
  // Starts bottom right; remembers the corner while the band moves.
  const corner = useSharedValue({ right: true, bottom: true });
  const x = useSharedValue(right);
  const y = useSharedValue(lower);
  const start = useSharedValue({ x: 0, y: 0 });

  useEffect(() => {
    const at = corner.get();
    const tx = at.right ? right : left;
    const ty = at.bottom ? lower : upper;
    x.set(moves ? withSpring(tx, { dampingRatio: 0.9 }) : tx);
    y.set(moves ? withSpring(ty, { dampingRatio: 0.9 }) : ty);
  }, [left, right, upper, lower, moves, corner, x, y]);

  const pan = usePanGesture({
    activeOffsetX: [-6, 6],
    activeOffsetY: [-6, 6],
    onActivate: () => {
      'worklet';
      start.set({ x: x.get(), y: y.get() });
    },
    onUpdate: (event) => {
      'worklet';
      x.set(start.get().x + event.translationX);
      y.set(start.get().y + event.translationY);
    },
    onDeactivate: (event) => {
      'worklet';
      const toRight = x.get() + WIDTH / 2 + event.velocityX * 0.1 > width / 2;
      const toBottom = y.get() + HEIGHT / 2 + event.velocityY * 0.1 > (upper + lower + HEIGHT) / 2;
      corner.set({ right: toRight, bottom: toBottom });
      const tx = toRight ? right : left;
      const ty = toBottom ? lower : upper;
      x.set(moves ? withSpring(tx, { dampingRatio: 0.85 }) : tx);
      y.set(moves ? withSpring(ty, { dampingRatio: 0.85 }) : ty);
    },
  });
  const position = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 0,
            top: 0,
            width: WIDTH,
            height: HEIGHT,
            borderRadius: 20,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.25)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
          },
          position,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Drag it to another corner"
          disabled={!canSwap}
          onPress={() => {
            haptic('selection');
            onSwap();
          }}
          style={{ flex: 1 }}
        >
          <RTCView
            // A new native view per stream (swapping big and small changes the stream).
            key={streamURL}
            streamURL={streamURL}
            objectFit="cover"
            mirror={mirror}
            zOrder={1}
            style={StyleSheet.absoluteFill}
          />
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}
