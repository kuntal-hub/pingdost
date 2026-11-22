// Connect Four on the phone (Phase 43): a frame of 7 by 6 holes; tap a column to drop a disc.
// The newest disc falls from the top and bounces; four in a row are ringed.
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { Tap } from '@/components/tap';
import {
  C4_COLUMNS,
  C4_ROWS,
  connectFourColor,
  type ConnectFourMove,
  type ConnectFourState,
} from '@pingdost/games';
import { gameBoardColors, type GamePlayerLook } from '@pingdost/ui-tokens';

import type { TurnBoardProps } from './board-props';

function Disc({ look, size, id }: { look: GamePlayerLook; size: number; id: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 10 10">
      <Defs>
        <RadialGradient id={id} cx="38%" cy="32%" r="70%">
          <Stop offset="0" stopColor={look.light} />
          <Stop offset="0.55" stopColor={look.fill} />
          <Stop offset="1" stopColor={look.dark} />
        </RadialGradient>
      </Defs>
      <Circle cx={5} cy={5} r={4.4} fill={`url(#${id})`} stroke={look.ring} strokeWidth={0.45} />
      <Circle
        cx={5}
        cy={5}
        r={2.7}
        fill="none"
        stroke={look.dark}
        strokeOpacity={0.35}
        strokeWidth={0.4}
      />
    </Svg>
  );
}

export function ConnectFourBoard({
  state,
  legal,
  last,
  onMove,
  size,
  dark,
  moves,
  pace,
}: TurnBoardProps<ConnectFourState, ConnectFourMove>) {
  const colors = gameBoardColors(dark);
  const pad = size * 0.03;
  const cell = (size - pad * 2) / C4_COLUMNS;
  const height = cell * C4_ROWS + pad * 2;
  const open = new Set(legal.map((m) => m.column));
  const winning = new Set(state.line ?? []);
  const lastIndex =
    last?.move !== undefined
      ? state.cells.findIndex(
          (_, i) => i % C4_COLUMNS === last.move!.column && state.cells[i]! >= 0,
        )
      : -1;
  const disc = size > 0 ? cell * 0.86 : 0;
  return (
    <View
      style={{ width: size, height, borderRadius: 18, backgroundColor: colors.frame, padding: pad }}
    >
      {Array.from({ length: C4_ROWS * C4_COLUMNS }, (_, i) => {
        const row = Math.floor(i / C4_COLUMNS);
        const col = i % C4_COLUMNS;
        const owner = state.cells[i]!;
        const left = pad + col * cell + (cell - disc) / 2;
        const top = pad + row * cell + (cell - disc) / 2;
        const look = owner >= 0 ? colors.players[connectFourColor(state, owner)] : null;
        const falling = i === lastIndex && moves;
        const drop = top + disc;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left,
              top,
              width: disc,
              height: disc,
              borderRadius: disc / 2,
              backgroundColor: colors.board,
            }}
          >
            {look && (
              <Animated.View
                key={falling ? `drop${last?.id}` : 'still'}
                style={[
                  {
                    width: disc,
                    height: disc,
                    borderRadius: disc / 2,
                    boxShadow: winning.has(i) ? `0 0 0 3px ${colors.cell}` : undefined,
                  },
                  falling
                    ? {
                        animationName: {
                          '0%': { transform: [{ translateY: -drop }] },
                          '72%': { transform: [{ translateY: 0 }] },
                          '86%': { transform: [{ translateY: -disc * 0.18 }] },
                          '100%': { transform: [{ translateY: 0 }] },
                        },
                        animationDuration: Math.max(180, pace.step + row * (pace.hop / 3)),
                        animationTimingFunction: 'ease-in',
                      }
                    : {},
                ]}
              >
                <Disc look={look} size={disc} id={`c4-${i}`} />
              </Animated.View>
            )}
          </View>
        );
      })}
      {Array.from({ length: C4_COLUMNS }, (_, col) =>
        open.has(col) ? (
          <Tap
            key={col}
            accessibilityRole="button"
            accessibilityLabel={`Column ${col + 1}. Drop a disc`}
            feedback="light"
            onPress={() => onMove({ column: col })}
            style={{ position: 'absolute', left: pad + col * cell, top: 0, width: cell, height }}
          />
        ) : null,
      )}
    </View>
  );
}
