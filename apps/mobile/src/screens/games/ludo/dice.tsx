// The die (ADR 0050): a shaded cube in the roller's color that tumbles for the whole roll (two
// turns with small hops), then settles. It is the roll button on the user's turn. While it
// tumbles it shows no pips: the number appears only once it lands, so no passing face reads as
// the result.
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

// The hops stay small and the highest ones fall on square angles, so the spinning die never
// leaves its slot in the player panel (`DIE_SLOT` in panels.tsx: at most 13 px past its edge,
// where the panel's border starts). Keep in step with `pd-tumble` in the web app's styles.css.
const TUMBLE = {
  '0%': { transform: [{ translateY: 0 }, { rotate: '0deg' }, { scale: 1 }] },
  '18%': { transform: [{ translateY: -4 }, { rotate: '180deg' }, { scale: 1.04 }] },
  '40%': { transform: [{ translateY: 0 }, { rotate: '330deg' }, { scale: 0.96 }] },
  '58%': { transform: [{ translateY: -3 }, { rotate: '450deg' }, { scale: 1.02 }] },
  '76%': { transform: [{ translateY: 0 }, { rotate: '560deg' }, { scale: 0.98 }] },
  '90%': { transform: [{ translateY: -1 }, { rotate: '690deg' }, { scale: 1 }] },
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
  // No pips while rolling: the result shows only when the die has landed.
  const pips: readonly (readonly [number, number])[] = rolling ? [] : PIPS[value ?? 6]!;
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
      accessibilityLabel={
        ready
          ? 'Roll the dice'
          : rolling
            ? 'Rolling the dice'
            : value
              ? `The dice shows ${value}`
              : 'Dice'
      }
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
          // Without motion a roll is a dimmed blank die until the number shows.
          opacity: idle ? 0.55 : rolling && !moves ? 0.6 : 1,
          ...animation,
        }}
      >
        <View style={{ flex: 1 }}>
          {pips.map(([column, row], i) => (
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
