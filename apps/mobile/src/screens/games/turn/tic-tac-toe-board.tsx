// Tic-Tac-Toe on the phone (Phase 43): a 3 by 3 grid; X is drawn in red, O in blue. The newest
// mark pops in; three in a row get a line through them.
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle, Line } from 'react-native-svg';

import { Tap } from '@/components/tap';
import { CSS_POP } from '@/theme/motion';
import { ticTacToeMark, type TicTacToeMove, type TicTacToeState } from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { POP_IN, type TurnBoardProps } from './board-props';

const ROWS = ['top', 'middle', 'bottom'];
const COLS = ['left', 'centre', 'right'];

function Mark({ mark, size, color }: { mark: 'X' | 'O'; size: number; color: string }) {
  const w = size * 0.11;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {mark === 'X' ? (
        <>
          <Line
            x1={size * 0.22}
            y1={size * 0.22}
            x2={size * 0.78}
            y2={size * 0.78}
            stroke={color}
            strokeWidth={w}
            strokeLinecap="round"
          />
          <Line
            x1={size * 0.78}
            y1={size * 0.22}
            x2={size * 0.22}
            y2={size * 0.78}
            stroke={color}
            strokeWidth={w}
            strokeLinecap="round"
          />
        </>
      ) : (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={size * 0.29}
          stroke={color}
          strokeWidth={w}
          fill="none"
        />
      )}
    </Svg>
  );
}

export function TicTacToeBoard({
  state,
  legal,
  last,
  onMove,
  size,
  dark,
  moves,
  pace,
}: TurnBoardProps<TicTacToeState, TicTacToeMove>) {
  const colors = gameBoardColors(dark);
  const cell = size / 3;
  const open = new Set(legal.map((m) => m.cell));
  const markColor = (seat: number) =>
    ticTacToeMark(state, seat) === 'X' ? colors.players.red.fill : colors.players.blue.fill;
  const line = state.line;
  const center = (i: number) => ({
    x: (i % 3) * cell + cell / 2,
    y: Math.floor(i / 3) * cell + cell / 2,
  });
  return (
    <View style={{ width: size, height: size, borderRadius: 20, backgroundColor: colors.cell }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        {[1, 2].map((k) => (
          <Line
            key={`v${k}`}
            x1={k * cell}
            y1={cell * 0.12}
            x2={k * cell}
            y2={size - cell * 0.12}
            stroke={colors.line}
            strokeWidth={4}
            strokeLinecap="round"
          />
        ))}
        {[1, 2].map((k) => (
          <Line
            key={`h${k}`}
            x1={cell * 0.12}
            y1={k * cell}
            x2={size - cell * 0.12}
            y2={k * cell}
            stroke={colors.line}
            strokeWidth={4}
            strokeLinecap="round"
          />
        ))}
      </Svg>
      {state.cells.map((owner, i) => {
        const fresh = last?.move?.cell === i;
        const label = `${ROWS[Math.floor(i / 3)]} ${COLS[i % 3]}`;
        const style = {
          position: 'absolute' as const,
          left: (i % 3) * cell,
          top: Math.floor(i / 3) * cell,
          width: cell,
          height: cell,
        };
        if (owner < 0) {
          return open.has(i) ? (
            <Tap
              key={i}
              accessibilityRole="button"
              accessibilityLabel={`${label}, empty. Play here`}
              feedback="light"
              onPress={() => onMove({ cell: i })}
              style={style}
            />
          ) : (
            <View key={i} accessibilityLabel={`${label}, empty`} style={style} />
          );
        }
        return (
          <Animated.View
            key={`${i}-${fresh ? last?.id : 'old'}`}
            accessibilityLabel={`${label}, ${ticTacToeMark(state, owner)}`}
            style={[
              style,
              fresh && moves
                ? {
                    animationName: POP_IN,
                    animationDuration: pace.step,
                    animationTimingFunction: CSS_POP,
                  }
                : {},
            ]}
          >
            <Mark mark={ticTacToeMark(state, owner)} size={cell} color={markColor(owner)} />
          </Animated.View>
        );
      })}
      {line && (
        <Svg width={size} height={size} style={{ position: 'absolute' }} pointerEvents="none">
          <Line
            x1={center(line[0]!).x}
            y1={center(line[0]!).y}
            x2={center(line[2]!).x}
            y2={center(line[2]!).y}
            stroke={markColor(state.cells[line[0]!]!)}
            strokeOpacity={0.55}
            strokeWidth={cell * 0.16}
            strokeLinecap="round"
          />
        </Svg>
      )}
    </View>
  );
}
