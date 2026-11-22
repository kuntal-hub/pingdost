// What the solo and friend pages of the turn games share in the browser (Phase 43): the
// players' strip (whose turn, scores, the timer), the die, keys, and sounds per step.
import { useEffect, useRef } from 'react';

import { cn } from '@/lib/cn';
import { useAppearance } from '@/theme';
import {
  isDraw,
  snakesPath,
  turnSeatColor,
  type AnyTurnRules,
  type DotsState,
  type SnakesState,
  type TurnCore,
  type TurnLast,
  type TurnPace,
  type TurnWaiting,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { Dice } from '../ludo/dice';
import { ShapeIcon } from '../shape';
import { playGameSound } from '../sounds';

export function useMotionLevel(): 'full' | 'calm' | 'off' {
  const setting = useAppearance((state) => state.prefs.motion);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return setting === 'full' && reduced ? 'calm' : setting;
}

function seatDetail(rules: AnyTurnRules, state: TurnCore, seat: number): string | null {
  if (rules.id === 'dots-and-boxes') {
    const score = (state as DotsState).scores[seat] ?? 0;
    return `${score} ${score === 1 ? 'box' : 'boxes'}`;
  }
  if (rules.id === 'snakes-and-ladders') {
    const square = (state as SnakesState).positions[seat] ?? 0;
    return square === 0 ? 'Start' : `Square ${square}`;
  }
  return null;
}

export function PlayersStrip({
  rules,
  state,
  names,
  over,
  timeLeft,
}: {
  rules: AnyTurnRules;
  state: TurnCore;
  names: (seat: number) => string;
  over: boolean;
  timeLeft: number | null;
}) {
  const dark = useAppearance((s) => s.dark);
  const colors = gameBoardColors(dark);
  return (
    <ul className="flex w-full flex-wrap justify-center gap-2">
      {Array.from({ length: state.seats }, (_, seat) => {
        const color = turnSeatColor(rules.id, state, seat);
        const look = colors.players[color];
        const active = !over && state.current === seat;
        const left = state.left[seat];
        const detail = left ? 'Left' : seatDetail(rules, state, seat);
        const side = rules.sideName(state, seat);
        return (
          <li
            key={seat}
            aria-label={`${names(seat)}, ${side}${detail ? `, ${detail}` : ''}${active ? ', playing now' : ''}`}
            className={cn(
              'flex min-w-36 items-center gap-2 rounded-2xl border-2 px-3 py-2',
              active ? 'bg-surface' : 'border-transparent',
              left && 'opacity-50',
            )}
            style={active ? { borderColor: look.ring } : undefined}
          >
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold"
              style={{ backgroundColor: look.fill, borderColor: look.ring, color: look.on }}
            >
              {rules.id === 'tic-tac-toe' ? (
                side
              ) : (
                <ShapeIcon color={color} size={14} fill={look.on} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold">{names(seat)}</span>
              {detail && <span className="block text-xs text-muted">{detail}</span>}
              {active && timeLeft !== null && (
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-raised">
                  <span
                    className="block h-full"
                    style={{ width: `${Math.round(timeLeft * 100)}%`, backgroundColor: look.fill }}
                  />
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function TurnDie({
  rules,
  state,
  waiting,
  last,
  you,
  animate,
  pace,
  onRoll,
}: {
  rules: AnyTurnRules;
  state: TurnCore;
  waiting: TurnWaiting;
  last: TurnLast<TurnCore, unknown> | null;
  you: number;
  animate: boolean;
  pace: TurnPace;
  onRoll: () => void;
}) {
  const dark = useAppearance((s) => s.dark);
  if (!rules.dice) return null;
  const rolling = waiting === 'rolling';
  const seat = rolling || !last ? state.current : last.seat;
  const look = gameBoardColors(dark).players[turnSeatColor(rules.id, state, seat)];
  return (
    <Dice
      value={last?.die ?? null}
      rolling={rolling}
      rollId={last?.id ?? 0}
      look={look}
      ready={waiting === 'you' && state.current === you}
      animate={animate}
      duration={pace.roll}
      size={56}
      onRoll={onRoll}
    />
  );
}

/** Keys: Space or R rolls in dice games; 1–9 (Tic-Tac-Toe) or 1–7 (Connect Four) play there. */
export function useTurnKeys(
  rules: AnyTurnRules,
  act: { roll(): void; move(move: unknown): void } | null,
) {
  const latest = useRef(act);
  latest.current = act;
  useEffect(() => {
    const keys = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [role="dialog"], [role="menu"]')) return;
      if (rules.dice && (event.key === ' ' || event.key.toLowerCase() === 'r')) {
        if (target?.closest('button, [role="button"]') && event.key === ' ') return;
        event.preventDefault();
        latest.current?.roll();
        return;
      }
      const n = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
      if (n < 0) return;
      if (rules.id === 'tic-tac-toe') latest.current?.move({ cell: n });
      else if (rules.id === 'connect-four' && n < 7) latest.current?.move({ column: n });
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [rules]);
}

interface StepView {
  state: TurnCore;
  you: number;
  waiting: TurnWaiting;
  last: TurnLast<TurnCore, unknown> | null;
}

/** Sounds per step (ADR 0050's set); a restored game is silent. */
export function useTurnSounds(
  rules: AnyTurnRules,
  view: StepView | null,
  pace: TurnPace,
  animate: boolean,
): void {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const seen = useRef<{ step: number; rolling: boolean; over: boolean } | null>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!view) return;
    if (!seen.current) {
      seen.current = {
        step: view.last?.id ?? 0,
        rolling: view.waiting === 'rolling',
        over: view.waiting === 'over',
      };
      return;
    }
    const at = (ms: number, kind: Parameters<typeof playGameSound>[0]) =>
      timers.current.push(setTimeout(() => playGameSound(kind), ms));
    const rolling = view.waiting === 'rolling';
    if (rolling && !seen.current.rolling) playGameSound('roll');
    seen.current.rolling = rolling;
    const last = view.last;
    if (last && last.id !== seen.current.step) {
      seen.current.step = last.id;
      if (last.kind === 'roll' && last.die !== undefined) {
        const before = last.before as SnakesState;
        const path = snakesPath(before.positions[last.seat]!, last.die, before.settings);
        const hop = animate ? pace.hop : 0;
        path.walk.forEach((_, i) => at((i + 0.85) * hop, 'hop'));
        if (path.jump) {
          at(
            path.walk.length * hop + (animate ? pace.slide : 0),
            path.jump.kind === 'ladder' ? 'home' : 'capture',
          );
        }
      } else if (last.kind === 'move' || last.kind === 'proxy') {
        const closed =
          rules.id === 'dots-and-boxes' &&
          (last.state as DotsState).scores.some(
            (s, i) => s > (last.before as DotsState).scores[i]!,
          );
        playGameSound(closed ? 'capture' : 'hop');
      }
    }
    if (view.waiting === 'over' && !seen.current.over) {
      seen.current.over = true;
      const won =
        view.you >= 0 &&
        view.state.ranks?.[view.you] === 1 &&
        !view.state.left[view.you] &&
        !isDraw(view.state);
      if (won) at(400, 'win');
    }
  }, [rules, view, pace, animate]);
}
