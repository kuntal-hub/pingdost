// Player panels in the board's corners (ADR 0050): each player sits by their own yard with
// their own die. The active panel is outlined and tinted in the player's color and holds the
// big die; the user (always bottom left) rolls with theirs. In games with friends the panel
// shows the person's name, and on the user's own turn a ring around their avatar runs down the
// 30 s (Phase 42; other players' clocks are not shown).
//
// The avatar and the die sit in fixed slots (the phone's panels.tsx has the same sizes) that
// hold the ring and the die's tumble, so rows keep their height as turns pass and nothing
// reaches the panel's border.
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
  /** The share of the turn's time left, 0–1: only on the user's own panel during their turn. */
  timeLeft?: number | null;
}

/** The avatar's slot (44 px, `size-11`) holds the avatar (32 px) and the ring around it. */
const RING_STROKE = 3;
const RING_RADIUS = 22 - RING_STROKE / 2;

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
        'pd-card flex min-w-0 flex-1 items-center gap-1 rounded-2xl p-2',
        !left && 'flex-row-reverse',
      )}
      style={{
        borderWidth: 2,
        borderColor: active ? look.ring : 'transparent',
        // A light wash of the player's color inside the outline, and a soft glow that stays
        // within the gap around the panel.
        backgroundImage: active ? `linear-gradient(${look.fill}1F, ${look.fill}1F)` : undefined,
        boxShadow: active ? `0 0 8px ${look.fill}66` : undefined,
      }}
    >
      <span className="relative flex size-11 shrink-0 items-center justify-center">
        {timeLeft != null && (
          // A sibling of the avatar in the same square, so both share one center.
          <svg aria-hidden viewBox="0 0 44 44" className="absolute inset-0 size-11 -rotate-90">
            <circle
              cx="22"
              cy="22"
              r={RING_RADIUS}
              fill="none"
              stroke={look.ring}
              strokeOpacity={0.18}
              strokeWidth={RING_STROKE}
            />
            <circle
              cx="22"
              cy="22"
              r={RING_RADIUS}
              fill="none"
              stroke={timeLeft < 0.25 ? 'rgb(var(--pd-danger))' : look.ring}
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${Math.max(0, timeLeft) * 100} 100`}
            />
          </svg>
        )}
        <span
          className="flex size-8 items-center justify-center rounded-full border-2"
          style={{
            backgroundImage: `linear-gradient(145deg, ${look.light}, ${look.fill} 55%, ${look.dark})`,
            borderColor: look.ring,
          }}
        >
          <ShapeIcon color={player.color} size={15} fill={look.on} />
        </span>
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
      {/* With the panel's padding this slot holds the active die's tumble (`pd-tumble`). */}
      <span className="flex size-[50px] shrink-0 items-center justify-center">
        <Dice
          value={lastDie}
          rolling={active && view.waiting === 'rolling'}
          rollId={view.lastRoll?.seat === seat ? view.lastRoll.id : 0}
          look={look}
          ready={active && view.waiting === 'you-roll'}
          animate={animate}
          duration={rollMs}
          size={active ? 40 : 30}
          idle={!active}
          onRoll={onRoll}
        />
      </span>
    </div>
  );
}
