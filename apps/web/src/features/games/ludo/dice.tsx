// The die (ADR 0050): a shaded cube in the roller's color that tumbles for the whole roll
// (`pd-tumble`), then settles; it beckons when it is the user's roll and is the roll button.
import { useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import type { GamePlayerLook } from '@pingdost/ui-tokens';

const PIPS: Record<number, readonly number[]> = {
  // Cells of a 3×3 grid, row by row.
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

interface DiceProps {
  value: number | null;
  rolling: boolean;
  rollId: number;
  look: GamePlayerLook;
  ready: boolean;
  animate: boolean;
  /** How long a roll tumbles (the controller's pace). */
  duration: number;
  size: number;
  /** Dimmed: another player's last roll. */
  idle?: boolean;
  onRoll: () => void;
}

export function Dice({
  value,
  rolling,
  rollId,
  look,
  ready,
  animate,
  duration,
  size,
  idle = false,
  onRoll,
}: DiceProps) {
  const [spinFace, setSpinFace] = useState(1);
  useEffect(() => {
    if (!rolling || !animate) return;
    const timer = setInterval(() => setSpinFace(1 + Math.floor(Math.random() * 6)), 70);
    return () => clearInterval(timer);
  }, [rolling, animate]);
  const face = rolling && animate ? spinFace : (value ?? 6);
  const pip = Math.round(size * 0.17);
  return (
    <button
      type="button"
      key={rolling ? `rolling${rollId}` : `face${rollId}`}
      disabled={!ready}
      aria-label={ready ? 'Roll the dice (Space)' : value ? `The dice shows ${value}` : 'Dice'}
      aria-busy={rolling}
      onClick={onRoll}
      className={cn(
        'pd-press grid shrink-0 cursor-pointer grid-cols-3 grid-rows-3 disabled:cursor-default',
        rolling ? 'pd-tumble' : ready ? 'pd-beckon' : value !== null && !idle && 'pd-settle-die',
        idle && 'opacity-55',
        rolling && !animate && 'opacity-60',
      )}
      style={{
        width: size,
        height: size,
        padding: size * 0.15,
        borderRadius: size * 0.22,
        border: `${Math.max(1.5, size * 0.04)}px solid ${look.ring}`,
        backgroundImage: `linear-gradient(145deg, ${look.light}, ${look.fill} 52%, ${look.dark})`,
        boxShadow: `0 ${size * 0.08}px ${size * 0.14}px rgb(0 0 0 / 0.35), inset 0 ${-size * 0.06}px 0 ${look.dark}`,
        animationDuration: rolling ? `${duration}ms` : undefined,
      }}
    >
      {Array.from({ length: 9 }, (_, cell) => (
        <span
          key={cell}
          aria-hidden
          className="m-auto rounded-full"
          style={{
            width: pip,
            height: pip,
            backgroundColor: PIPS[face]!.includes(cell) ? look.on : 'transparent',
            boxShadow: PIPS[face]!.includes(cell)
              ? `inset 0 ${pip * 0.15}px ${pip * 0.2}px rgb(0 0 0 / 0.35)`
              : undefined,
          }}
        />
      ))}
    </button>
  );
}
