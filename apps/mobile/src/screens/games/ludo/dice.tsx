// The die: spins while rolling, pops the result, and is the "roll" button on the user's turn.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Tap } from '@/components/tap';
import { CSS_EASE_IN_OUT, CSS_POP } from '@/theme/motion';
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

const WOBBLE = {
  '0%': { transform: [{ rotate: '0deg' }, { scale: 1 }] },
  '25%': { transform: [{ rotate: '-16deg' }, { scale: 0.92 }] },
  '50%': { transform: [{ rotate: '12deg' }, { scale: 1.06 }] },
  '75%': { transform: [{ rotate: '-8deg' }, { scale: 0.96 }] },
  '100%': { transform: [{ rotate: '0deg' }, { scale: 1 }] },
};
const POP = {
  '0%': { transform: [{ scale: 0.7 }] },
  '60%': { transform: [{ scale: 1.15 }] },
  '100%': { transform: [{ scale: 1 }] },
};
const BECKON = {
  '0%': { transform: [{ scale: 1 }] },
  '50%': { transform: [{ scale: 1.07 }] },
  '100%': { transform: [{ scale: 1 }] },
};

interface DiceProps {
  value: number | null;
  rolling: boolean;
  /** Changes with every roll, so the same face twice still pops. */
  rollId: number;
  look: GamePlayerLook;
  /** The user may roll now. */
  ready: boolean;
  onRoll: () => void;
  size: number;
  moves: boolean;
}

export function Dice({ value, rolling, rollId, look, ready, onRoll, size, moves }: DiceProps) {
  const [spinFace, setSpinFace] = useState(1);
  useEffect(() => {
    if (!rolling || !moves) return;
    const timer = setInterval(() => setSpinFace(1 + Math.floor(Math.random() * 6)), 75);
    return () => clearInterval(timer);
  }, [rolling, moves]);

  const face = rolling && moves ? spinFace : (value ?? 6);
  const pip = size * 0.16;
  const animation = rolling
    ? moves
      ? {
          animationName: WOBBLE,
          animationDuration: 380,
          animationIterationCount: 'infinite' as const,
        }
      : {}
    : ready && moves
      ? {
          animationName: BECKON,
          animationDuration: 1100,
          animationIterationCount: 'infinite' as const,
          animationTimingFunction: CSS_EASE_IN_OUT,
        }
      : moves && value !== null
        ? { animationName: POP, animationDuration: 320, animationTimingFunction: CSS_POP }
        : {};

  return (
    <Tap
      accessibilityLabel={ready ? 'Roll the dice' : value ? `The dice shows ${value}` : 'Dice'}
      accessibilityState={{ disabled: !ready, busy: rolling }}
      disabled={!ready}
      feedback="light"
      scaleTo={0.9}
      onPress={onRoll}
    >
      <Animated.View
        key={rolling ? 'rolling' : `face${rollId}${ready ? 'r' : ''}`}
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.22,
          backgroundColor: look.fill,
          borderWidth: 3,
          borderColor: look.ring,
          padding: size * 0.14,
          opacity: rolling && !moves ? 0.6 : 1,
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
