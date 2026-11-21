// The die: spins while rolling (`pd-roll`), pops the result, and is the roll button.
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
  onRoll: () => void;
}

export function Dice({ value, rolling, rollId, look, ready, animate, onRoll }: DiceProps) {
  const [spinFace, setSpinFace] = useState(1);
  useEffect(() => {
    if (!rolling || !animate) return;
    const timer = setInterval(() => setSpinFace(1 + Math.floor(Math.random() * 6)), 75);
    return () => clearInterval(timer);
  }, [rolling, animate]);
  const face = rolling && animate ? spinFace : (value ?? 6);
  return (
    <button
      type="button"
      key={rolling ? 'rolling' : `face${rollId}`}
      disabled={!ready}
      aria-label={ready ? 'Roll the dice (Space)' : value ? `The dice shows ${value}` : 'Dice'}
      aria-busy={rolling}
      onClick={onRoll}
      className={cn(
        'pd-press grid size-16 cursor-pointer grid-cols-3 grid-rows-3 gap-0.5 rounded-2xl border-[3px] p-2 disabled:cursor-default',
        rolling ? 'pd-roll' : ready ? 'pd-beckon' : value !== null && 'pd-pop',
        rolling && !animate && 'opacity-60',
      )}
      style={{ backgroundColor: look.fill, borderColor: look.ring }}
    >
      {Array.from({ length: 9 }, (_, cell) => (
        <span
          key={cell}
          aria-hidden
          className="m-auto size-2.5 rounded-full"
          style={{ backgroundColor: PIPS[face]!.includes(cell) ? look.on : 'transparent' }}
        />
      ))}
    </button>
  );
}
