// Player panels in the board's corners (ADR 0050): each player sits by their own yard with
// their own die. The active player's panel glows and holds the big die; the user (always bottom
// left) rolls by tapping theirs. Phase 42 draws the turn timers around the avatar.
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { BotIcon, Icon } from '@/components/icon';
import { Text } from '@/components/text';
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
}

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
}: PanelProps) {
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
  const name = seatName(kind, player.color);

  const avatar = (
    <View
      className="items-center justify-center rounded-full"
      style={{
        width: 40,
        height: 40,
        backgroundImage: `linear-gradient(145deg, ${look.light}, ${look.fill} 55%, ${look.dark})`,
        borderWidth: 2,
        borderColor: look.ring,
      }}
    >
      <ShapeGlyph color={player.color} size={18} fill={look.on} />
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
    <View style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center' }}>
      <Dice
        value={lastDie}
        rolling={rolling}
        rollId={view.lastRoll?.seat === seat ? view.lastRoll.id : 0}
        look={look}
        ready={ready}
        onRoll={onRoll}
        size={active ? 46 : 34}
        moves={moves}
        duration={rollMs}
        idle={!active}
      />
    </View>
  );

  return (
    <Animated.View
      accessibilityLabel={`${name}${kind === 'computer' ? `, computer, ${BOT_LEVEL_NAMES[level]}` : ''}, ${status}${active ? ', playing now' : ''}`}
      className={`flex-row items-center gap-2 rounded-2xl bg-surface p-1.5 ${left ? '' : 'flex-row-reverse'}`}
      style={{
        width,
        borderWidth: 2,
        borderColor: active ? look.ring : 'transparent',
        boxShadow: active ? `0 0 14px 2px ${look.fill}` : undefined,
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
