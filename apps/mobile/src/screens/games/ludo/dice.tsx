// The die (ADR 0050): a shaded cube in the roller's color that tumbles for the whole roll (two
// turns with bounces, faces flicking), then settles. It is the roll button on the user's turn.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Tap } from '@/components/tap';
import { CSS_EASE_IN_OUT, CSS_EASE_OUT, CSS_POP } from '@/theme/motion';
import type { GamePlayerLook } from '@pingdost/ui-tokens';

// Pip positions on a 3×3 grid (column, row) for each face.
const PIPS: Record<number, readonly (readonly [number, number])[]> = {
  1: [[1, 1]],
  2: [
    [0, 0],
    [2, 2],
  ],
  3: [
    [0, 0],
    [1, 1],
    [2, 2],
  ],
  4: [
    [0, 0],
    [2, 0],
    [0, 2],
    [2, 2],
  ],
  5: [
    [0, 0],
    [2, 0],
    [1, 1],
    [0, 2],
    [2, 2],
  ],
  6: [
    [0, 0],
    [2, 0],
    [0, 1],
    [2, 1],
    [0, 2],
    [2, 2],
  ],
};

const TUMBLE = {
  '0%': { transform: [{ translateY: 0 }, { rotate: '0deg' }, { scale: 1 }] },
  '20%': { transform: [{ translateY: -22 }, { rotate: '160deg' }, { scale: 1.14 }] },
  '42%': { transform: [{ translateY: 0 }, { rotate: '310deg' }, { scale: 0.92 }] },
  '60%': { transform: [{ translateY: -10 }, { rotate: '420deg' }, { scale: 1.06 }] },
  '78%': { transform: [{ translateY: 0 }, { rotate: '520deg' }, { scale: 0.97 }] },
  '90%': { transform: [{ translateY: -3 }, { rotate: '700deg' }, { scale: 1.01 }] },
  '100%': { transform: [{ translateY: 0 }, { rotate: '720deg' }, { scale: 1 }] },
};
const SETTLE = {
  '0%': { transform: [{ scale: 1.18 }] },
  '55%': { transform: [{ scale: 0.94 }] },
  '100%': { transform: [{ scale: 1 }] },
};
const BECKON = {
  '0%': { transform: [{ scale: 1 }, { rotate: '0deg' }] },
  '30%': { transform: [{ scale: 1.08 }, { rotate: '-6deg' }] },
  '60%': { transform: [{ scale: 1.08 }, { rotate: '6deg' }] },
  '100%': { transform: [{ scale: 1 }, { rotate: '0deg' }] },
};

interface DiceProps {
  value: number | null;
  rolling: boolean;
  /** Changes with every roll, so the same face twice still settles. */
  rollId: number;
  look: GamePlayerLook;
  /** The user may roll now. */
  ready: boolean;
  onRoll: () => void;
  size: number;
  moves: boolean;
  /** How long a roll tumbles (the controller's pace). */
  duration: number;
  /** Dimmed: another player's last roll. */
  idle?: boolean;
}

export function Dice({
  value,
  rolling,
  rollId,
  look,
  ready,
  onRoll,
  size,
  moves,
  duration,
  idle = false,
}: DiceProps) {
  const [spinFace, setSpinFace] = useState(1);
  useEffect(() => {
    if (!rolling || !moves) return;
    const timer = setInterval(() => setSpinFace(1 + Math.floor(Math.random() * 6)), 70);
    return () => clearInterval(timer);
  }, [rolling, moves]);

  const face = rolling && moves ? spinFace : (value ?? 6);
  const pip = size * 0.17;
  const animation = rolling
    ? moves
      ? {
          animationName: TUMBLE,
          animationDuration: duration,
          animationTimingFunction: CSS_EASE_OUT,
        }
      : {}
    : ready && moves
      ? {
          animationName: BECKON,
          animationDuration: 1200,
          animationIterationCount: 'infinite' as const,
          animationTimingFunction: CSS_EASE_IN_OUT,
        }
      : moves && value !== null && !idle
        ? { animationName: SETTLE, animationDuration: 300, animationTimingFunction: CSS_POP }
        : {};

  return (
    <Tap
      accessibilityLabel={ready ? 'Roll the dice' : value ? `The dice shows ${value}` : 'Dice'}
      accessibilityState={{ disabled: !ready, busy: rolling }}
      disabled={!ready}
      feedback="light"
      scaleTo={0.9}
      onPress={onRoll}
      hitSlop={Math.max(0, (48 - size) / 2)}
    >
      <Animated.View
        key={rolling ? `rolling${rollId}` : `face${rollId}${ready ? 'r' : ''}`}
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.22,
          backgroundImage: `linear-gradient(145deg, ${look.light}, ${look.fill} 52%, ${look.dark})`,
          borderWidth: Math.max(1.5, size * 0.04),
          borderColor: look.ring,
          boxShadow: `0 ${size * 0.08}px ${size * 0.14}px rgba(0, 0, 0, 0.35), inset 0 ${-size * 0.06}px 0 ${look.dark}`,
          padding: size * 0.15,
          opacity: idle ? 0.55 : 1,
          ...animation,
        }}
      >
        <View style={{ flex: 1 }}>
          {PIPS[face]!.map(([column, row], i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                width: pip,
                height: pip,
                borderRadius: pip / 2,
                backgroundColor: look.on,
                boxShadow: `inset 0 ${pip * 0.15}px ${pip * 0.2}px rgba(0, 0, 0, 0.35)`,
                left: `${column * 50}%`,
                top: `${row * 50}%`,
                transform: [{ translateX: -pip * (column / 2) }, { translateY: -pip * (row / 2) }],
              }}
            />
          ))}
        </View>
      </Animated.View>
    </Tap>
  );
}
