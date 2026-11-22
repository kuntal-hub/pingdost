// Player panels in the board's corners (ADR 0050): each player sits by their own yard with
// their own die. The active player's panel is outlined and tinted in their color and holds the
// big die; the user (always bottom left) rolls by tapping theirs. In games with friends the panel
// shows the person's name, and on the user's own turn a ring around their avatar runs down the
// 30 s (Phase 42; other players' clocks are not shown).
//
// The avatar and the die sit in fixed slots that hold the ring and the die's tumble, so nothing
// moves when a turn starts and nothing reaches the panel's border.
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { BotIcon, Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { usePalette } from '@/theme/theme-root';
import {
  BOT_LEVEL_NAMES,
  HOME,
  ordinal,
  seatName,
  type BotLevel,
  type LudoView,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { ShapeGlyph } from '../shape';
import { Dice } from './dice';

interface PanelProps {
  view: LudoView;
  seat: number;
  level: BotLevel;
  /** The panel sits on the left (avatar outside, die toward the board's middle) or right. */
  left: boolean;
  dark: boolean;
  moves: boolean;
  rollMs: number;
  /** This player's last roll, for their idle die. */
  lastDie: number | null;
  width: number;
  onRoll: () => void;
  /** The person's name (games with friends); the color's name otherwise. */
  name?: string;
  /** The share of the turn's time left, 0–1: only on the user's own panel during their turn. */
  timeLeft?: number | null;
}

/** The avatar's slot: the avatar plus room for the turn's ring around it. */
const AVATAR_SLOT = 44;
const AVATAR = 32;
/** The ring ends at the slot's edge and leaves 3 px between itself and the avatar. */
const RING_STROKE = 3;
const RING_RADIUS = AVATAR_SLOT / 2 - RING_STROKE / 2;
const RING = 2 * Math.PI * RING_RADIUS;
/** The die's slot: with the panel's padding it holds the active die's tumble (dice.tsx). */
const DIE_SLOT = 50;
const DIE_ACTIVE = 40;
const DIE_IDLE = 30;

export function PlayerPanel({
  view,
  seat,
  level,
  left,
  dark,
  moves,
  rollMs,
  lastDie,
  width,
  onRoll,
  name: personName,
  timeLeft,
}: PanelProps) {
  const palette = usePalette();
  const player = view.state.players[seat]!;
  const look = gameBoardColors(dark).players[player.color];
  const kind = view.seats[seat]!;
  const active = seat === view.state.current && view.waiting !== 'over';
  const rolling = active && view.waiting === 'rolling';
  const ready = active && view.waiting === 'you-roll';
  const home = player.tokens.filter((p) => p === HOME).length;
  const status = player.rank
    ? `${ordinal(player.rank)} place`
    : player.left
      ? 'Left'
      : `${home}/${player.tokens.length} home`;
  const name = personName ?? seatName(kind, player.color);

  const avatar = (
    <View
      style={{
        width: AVATAR_SLOT,
        height: AVATAR_SLOT,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {timeLeft != null && (
        // A sibling of the avatar in the same square, so both share one center.
        <Svg
          width={AVATAR_SLOT}
          height={AVATAR_SLOT}
          style={{ position: 'absolute', left: 0, top: 0, transform: [{ rotate: '-90deg' }] }}
        >
          <Circle
            cx={AVATAR_SLOT / 2}
            cy={AVATAR_SLOT / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={look.ring}
            strokeOpacity={0.18}
            strokeWidth={RING_STROKE}
          />
          <Circle
            cx={AVATAR_SLOT / 2}
            cy={AVATAR_SLOT / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={timeLeft < 0.25 ? palette.danger : look.ring}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={`${Math.max(0, timeLeft) * RING} ${RING}`}
          />
        </Svg>
      )}
      <View
        className="items-center justify-center rounded-full"
        style={{
          width: AVATAR,
          height: AVATAR,
          backgroundImage: `linear-gradient(145deg, ${look.light}, ${look.fill} 55%, ${look.dark})`,
          borderWidth: 2,
          borderColor: look.ring,
        }}
      >
        <ShapeGlyph color={player.color} size={15} fill={look.on} />
      </View>
    </View>
  );
  const label = (
    <View className={`min-w-0 flex-1 ${left ? '' : 'items-end'}`}>
      <View className={`flex-row items-center gap-1 ${left ? '' : 'flex-row-reverse'}`}>
        <Text numberOfLines={1} className="text-sm font-bold text-foreground">
          {name}
        </Text>
        {kind === 'computer' && <Icon icon={BotIcon} size={13} color="muted" />}
      </View>
      <Text numberOfLines={1} className="text-xs text-muted">
        {status}
      </Text>
    </View>
  );
  const die = (
    <View
      style={{ width: DIE_SLOT, height: DIE_SLOT, alignItems: 'center', justifyContent: 'center' }}
    >
      <Dice
        value={lastDie}
        rolling={rolling}
        rollId={view.lastRoll?.seat === seat ? view.lastRoll.id : 0}
        look={look}
        ready={ready}
        onRoll={onRoll}
        size={active ? DIE_ACTIVE : DIE_IDLE}
        moves={moves}
        duration={rollMs}
        idle={!active}
      />
    </View>
  );

  return (
    <Animated.View
      accessibilityLabel={`${name}${kind === 'computer' ? `, computer, ${BOT_LEVEL_NAMES[level]}` : ''}, ${status}${active ? ', playing now' : ''}`}
      // p-2, not p-1.5: 1.5 is not on the phone's spacing scale and gave no padding at all.
      className={`flex-row items-center gap-1 rounded-2xl bg-surface p-2 ${left ? '' : 'flex-row-reverse'}`}
      style={{
        width,
        borderWidth: 2,
        borderColor: active ? look.ring : 'transparent',
        // A light wash of the player's color inside the outline, and a soft glow that stays
        // within the gap around the panel.
        backgroundImage: active ? `linear-gradient(${look.fill}1F, ${look.fill}1F)` : undefined,
        boxShadow: active ? `0 0 8px ${look.fill}66` : undefined,
        transitionProperty: ['borderColor'],
        transitionDuration: moves ? 200 : 0,
      }}
    >
      {avatar}
      {label}
      {die}
    </Animated.View>
  );
}
