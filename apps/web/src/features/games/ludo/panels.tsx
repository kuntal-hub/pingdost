// Player panels in the board's corners (ADR 0050): each player sits by their own yard with
// their own die. The active panel glows and holds the big die; the user (always bottom left)
// rolls with theirs. In games with friends the panel shows the person's name, and a ring
// around the active player's avatar runs down their 30 s (Phase 42).
import { Bot } from 'lucide-react';

import { cn } from '@/lib/cn';
import {
  BOT_LEVEL_NAMES,
  HOME,
  ordinal,
  seatName,
  type BotLevel,
  type LudoView,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { ShapeIcon } from '../shape';
import { Dice } from './dice';

interface PanelProps {
  view: LudoView;
  seat: number;
  level: BotLevel;
  left: boolean;
  dark: boolean;
  animate: boolean;
  rollMs: number;
  lastDie: number | null;
  onRoll: () => void;
  /** The person's name (games with friends); the color's name otherwise. */
  name?: string;
  /** The share of the turn's time left, 0–1, while this player is on the clock. */
  timeLeft?: number | null;
}

export function PlayerPanel({
  view,
  seat,
  level,
  left,
  dark,
  animate,
  rollMs,
  lastDie,
  onRoll,
  name,
  timeLeft,
}: PanelProps) {
  const player = view.state.players[seat]!;
  const look = gameBoardColors(dark).players[player.color];
  const kind = view.seats[seat]!;
  const active = seat === view.state.current && view.waiting !== 'over';
  const home = player.tokens.filter((p) => p === HOME).length;
  const status = player.rank
    ? `${ordinal(player.rank)} place`
    : player.left
      ? 'Left'
      : `${home}/${player.tokens.length} home`;
  return (
    <div
      aria-current={active ? 'true' : undefined}
      className={cn(
        'pd-card flex min-w-0 flex-1 items-center gap-2 rounded-2xl border-2 p-1.5',
        !left && 'flex-row-reverse',
      )}
      style={{
        borderColor: active ? look.ring : 'transparent',
        boxShadow: active ? `0 0 14px 2px ${look.fill}` : undefined,
      }}
    >
      <span
        className="relative flex size-10 shrink-0 items-center justify-center rounded-full border-2"
        style={{
          backgroundImage: `linear-gradient(145deg, ${look.light}, ${look.fill} 55%, ${look.dark})`,
          borderColor: look.ring,
        }}
      >
        <ShapeIcon color={player.color} size={18} fill={look.on} />
        {timeLeft != null && (
          <svg aria-hidden viewBox="0 0 48 48" className="absolute -inset-1.5 size-13 -rotate-90">
            <circle
              cx="24"
              cy="24"
              r="22"
              fill="none"
              stroke={timeLeft < 0.25 ? 'rgb(var(--pd-danger))' : look.ring}
              strokeWidth="3.5"
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${Math.max(0, timeLeft) * 100} 100`}
            />
          </svg>
        )}
      </span>
      <span className={cn('min-w-0 flex-1 leading-tight', !left && 'text-right')}>
        <span
          className={cn('flex items-center gap-1 text-sm font-bold', !left && 'flex-row-reverse')}
        >
          <span className="truncate">{name ?? seatName(kind, player.color)}</span>
          {kind === 'computer' && (
            <>
              <Bot aria-hidden size={13} className="shrink-0 text-muted" />
              <span className="sr-only">computer, {BOT_LEVEL_NAMES[level]}</span>
            </>
          )}
        </span>
        <span className="block truncate text-xs text-muted">{status}</span>
      </span>
      <span
        className={cn('flex shrink-0 items-center justify-center', active ? 'size-14' : 'size-10')}
      >
        <Dice
          value={lastDie}
          rolling={active && view.waiting === 'rolling'}
          rollId={view.lastRoll?.seat === seat ? view.lastRoll.id : 0}
          look={look}
          ready={active && view.waiting === 'you-roll'}
          animate={animate}
          duration={rollMs}
          size={active ? 46 : 32}
          idle={!active}
          onRoll={onRoll}
        />
      </span>
    </div>
  );
}
