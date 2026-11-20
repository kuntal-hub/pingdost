import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, View } from 'react-native';

import { haptic, useMotion } from '@/theme/motion';
import { spacing, type ColorName } from '@pingdost/ui-tokens';

import { Icon, type LucideIcon } from './icon';

/** How far to drag before letting go commits. */
const COMMIT = 72;
const MAX = 110;
/** A drag this far sideways (and mostly sideways) is a swipe, not a scroll or a tap. */
const START = 16;

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

/** The action's icon behind the row, growing in as the row is dragged toward the line. */
function SwipeHint({
  side,
  x,
  align,
}: {
  side: SwipeSide;
  x: Animated.Value;
  align: 'left' | 'right';
}) {
  const progress =
    align === 'left'
      ? x.interpolate({ inputRange: [8, COMMIT], outputRange: [0, 1], extrapolate: 'clamp' })
      : x.interpolate({ inputRange: [-COMMIT, -8], outputRange: [1, 0], extrapolate: 'clamp' });
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.1] });
  return (
    <Animated.View
      importantForAccessibility="no"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        justifyContent: 'center',
        ...(align === 'left' ? { left: spacing[5] } : { right: spacing[5] }),
        opacity: progress,
        transform: [{ scale }],
      }}
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-accent/20">
        <Icon icon={side.icon} size={20} color={side.color ?? 'accent'} />
      </View>
    </Animated.View>
  );
}

/**
 * Drag a row sideways to reveal an action, past the line to commit it. The row always springs
 * back. Only a mostly sideways drag starts it, so the list's vertical scroll stays free. Screen
 * readers reach the same actions from the long-press sheet.
 *
 * A chat mounts dozens of these at once and most are never swiped, so it is a plain touch
 * responder: no native gesture handler or animated style per row, and the action's icon exists
 * only during a swipe. Per-row gesture handlers were most of a message bubble's cost when a chat
 * opened (ADR 0046).
 */
export function SwipeAction({ children, left, right, enabled = true }: SwipeActionProps) {
  const { moves } = useMotion();
  const [x] = useState(() => new Animated.Value(0));
  const [swiping, setSwiping] = useState(false);
  // The handlers below are made once; they read the current props from here.
  const current = useRef({ left, right, enabled });
  current.current = { left, right, enabled };

  const responder = useMemo(() => {
    let at = 0;
    let armed = false;
    const wants = (dx: number, dy: number) => {
      const { left: l, right: r, enabled: on } = current.current;
      if (!on || Math.abs(dx) < START || Math.abs(dx) < Math.abs(dy) * 2) return false;
      return dx > 0 ? l !== undefined : r !== undefined;
    };
    const finish = (velocity: number) => {
      const { left: l, right: r } = current.current;
      const side = at >= COMMIT ? l : at <= -COMMIT ? r : undefined;
      if (side) {
        haptic('light');
        side.onCommit();
      }
      at = 0;
      armed = false;
      Animated.spring(x, {
        toValue: 0,
        velocity,
        stiffness: 260,
        damping: 26,
        useNativeDriver: false,
      }).start(() => setSwiping(false));
    };
    return PanResponder.create({
      // Capture: the bubble's own press handler holds the touch until it turns into a swipe.
      onMoveShouldSetPanResponderCapture: (_event, g) => wants(g.dx, g.dy),
      onMoveShouldSetPanResponder: (_event, g) => wants(g.dx, g.dy),
      onPanResponderGrant: () => setSwiping(true),
      onPanResponderMove: (_event, g) => {
        const { left: l, right: r } = current.current;
        const next = (g.dx > 0 && !l) || (g.dx < 0 && !r) ? 0 : g.dx;
        // The further past the line, the less it follows.
        const magnitude = Math.abs(next);
        const eased = magnitude <= COMMIT ? magnitude : COMMIT + (magnitude - COMMIT) * 0.35;
        at = Math.sign(next) * Math.min(eased, MAX);
        x.setValue(at);
        // A tick as the row crosses the line, in either direction.
        const past = Math.abs(at) >= COMMIT;
        if (past !== armed) {
          armed = past;
          haptic('selection');
        }
      },
      onPanResponderRelease: (_event, g) => finish(g.vx),
      onPanResponderTerminate: () => finish(0),
      onPanResponderTerminationRequest: () => false,
      // Android: the list does not scroll while a row is being swiped.
      onShouldBlockNativeResponder: () => true,
    });
  }, [x]);

  // The tree stays the same when a row loses its actions (a message deleted for everyone while
  // on screen), so its content is updated in place rather than mounted again.
  if (!moves) return <View>{children}</View>;

  return (
    <View>
      {swiping && left && <SwipeHint side={left} x={x} align="left" />}
      {swiping && right && <SwipeHint side={right} x={x} align="right" />}
      <Animated.View
        style={swiping ? { transform: [{ translateX: x }] } : undefined}
        {...responder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}
