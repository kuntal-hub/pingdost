// Snakes and Ladders on the phone (Phase 43): a checkered 10 by 10 board with numbered squares,
// ladders and snakes drawn in code (PingDost's own layout), and a piece per player. Pieces start
// below the board; after a roll the mover's piece hops square by square, then climbs or slides.
import { memo } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Text } from '@/components/text';
import {
  LADDERS,
  SNAKES,
  SNAKES_COLOR_NAMES,
  SNAKES_COLORS,
  snakesPath,
  snakesSquareAt,
  type SnakesState,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import type { TurnBoardProps } from './board-props';
import { ShapeGlyph } from '../shape';

function center(square: number, cell: number) {
  const { row, col } = snakesSquareAt(square);
  return { x: col * cell + cell / 2, y: row * cell + cell / 2 };
}

/** The whole board as one drawing, drawn again only when its size or the theme changes. */
const Board = memo(function Board({ size, dark }: { size: number; dark: boolean }) {
  const colors = gameBoardColors(dark);
  const cell = size / 10;
  return (
    <Svg width={size} height={size}>
      {Array.from({ length: 100 }, (_, i) => {
        const square = i + 1;
        const { row, col } = snakesSquareAt(square);
        return (
          <G key={square}>
            <Rect
              x={col * cell}
              y={row * cell}
              width={cell}
              height={cell}
              fill={(row + col) % 2 === 0 ? colors.cell : colors.cellAlt}
            />
            <SvgText
              x={col * cell + 3}
              y={row * cell + cell * 0.3}
              fontSize={cell * 0.24}
              fill={colors.label}
            >
              {square}
            </SvgText>
          </G>
        );
      })}
      {LADDERS.map(([from, to]) => {
        const a = center(from, cell);
        const b = center(to, cell);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        const px = (-dy / length) * cell * 0.17;
        const py = (dx / length) * cell * 0.17;
        const rungs = Math.max(2, Math.floor(length / (cell * 0.45)));
        return (
          <G key={`l${from}`}>
            {[-1, 1].map((side) => (
              <Line
                key={side}
                x1={a.x + px * side}
                y1={a.y + py * side}
                x2={b.x + px * side}
                y2={b.y + py * side}
                stroke={colors.ladder}
                strokeWidth={cell * 0.08}
                strokeLinecap="round"
              />
            ))}
            {Array.from({ length: rungs }, (_, k) => {
              const t = (k + 0.5) / rungs;
              const x = a.x + dx * t;
              const y = a.y + dy * t;
              return (
                <Line
                  key={k}
                  x1={x - px}
                  y1={y - py}
                  x2={x + px}
                  y2={y + py}
                  stroke={colors.ladder}
                  strokeWidth={cell * 0.06}
                  strokeLinecap="round"
                />
              );
            })}
          </G>
        );
      })}
      {SNAKES.map(([head, tail], k) => {
        const a = center(head, cell);
        const b = center(tail, cell);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        const wave = Math.min(cell * 0.9, length * 0.22);
        const px = (-dy / length) * wave;
        const py = (dx / length) * wave;
        const path = `M ${a.x} ${a.y} C ${a.x + dx / 3 + px} ${a.y + dy / 3 + py}, ${a.x + (2 * dx) / 3 - px} ${a.y + (2 * dy) / 3 - py}, ${b.x} ${b.y}`;
        const color = colors.snakes[k % colors.snakes.length]!;
        const ex = (dx / length) * cell * 0.08;
        const ey = (dy / length) * cell * 0.08;
        return (
          <G key={`s${head}`}>
            <Path
              d={path}
              stroke={color}
              strokeWidth={cell * 0.26}
              strokeLinecap="round"
              fill="none"
            />
            <Path
              d={path}
              stroke={colors.cell}
              strokeOpacity={0.45}
              strokeWidth={cell * 0.06}
              strokeDasharray={`${cell * 0.12} ${cell * 0.18}`}
              fill="none"
            />
            <Circle cx={a.x} cy={a.y} r={cell * 0.22} fill={color} />
            {[-1, 1].map((side) => (
              <Circle
                key={side}
                cx={a.x - ex + (py / wave) * cell * 0.09 * side}
                cy={a.y - ey - (px / wave) * cell * 0.09 * side}
                r={cell * 0.05}
                fill={colors.cell}
              />
            ))}
          </G>
        );
      })}
    </Svg>
  );
});

export function SnakesBoard({
  state,
  last,
  size,
  dark,
  moves,
  pace,
}: TurnBoardProps<SnakesState, never>) {
  const colors = gameBoardColors(dark);
  const cell = size / 10;
  const strip = cell * 1.1;
  const token = cell * 0.56;
  // Pieces sharing a square sit side by side.
  const spot = (seat: number, square: number) => {
    if (square === 0) return { x: cell * (1 + seat * 1.4), y: size + strip / 2 };
    const sharing = state.positions.flatMap((p, s) => (p === square && !state.left[s] ? [s] : []));
    const c = center(square, cell);
    if (sharing.length <= 1) return c;
    const k = sharing.indexOf(seat);
    return {
      x: c.x + (k % 2 === 0 ? -1 : 1) * cell * 0.18,
      y: c.y + (k < 2 ? -1 : 1) * cell * 0.16,
    };
  };
  const mover = last?.kind === 'roll' && last.die !== undefined ? last.seat : -1;
  return (
    <View style={{ width: size, height: size + strip }}>
      <View style={{ borderRadius: 14, overflow: 'hidden' }}>
        <Board size={size} dark={dark} />
      </View>
      <Text
        className="absolute text-xs font-bold text-muted"
        style={{ left: 2, top: size + strip / 2 - 8 }}
      >
        Start
      </Text>
      {state.positions.map((square, seat) => {
        if (state.left[seat]) return null;
        const color = SNAKES_COLORS[seat] ?? 'red';
        const look = colors.players[color];
        const end = spot(seat, square);
        let animation = {};
        if (seat === mover && moves && last?.before) {
          const before = last.before;
          const path = snakesPath(before.positions[seat]!, last.die!, before.settings);
          const points = [
            spot(seat, before.positions[seat]!),
            ...path.walk.map((s) => center(s, cell)),
          ];
          if (path.jump) points.push(end);
          const hop = pace.hop;
          const total = path.walk.length * hop + (path.jump ? pace.slide : 0);
          if (total > 0 && points.length > 1) {
            const frames: Record<string, object> = {};
            let at = 0;
            points.forEach((p, k) => {
              if (k > 0) at += k <= path.walk.length ? hop : pace.slide;
              frames[`${Math.round((at / total) * 100)}%`] = {
                transform: [{ translateX: p.x - token / 2 }, { translateY: p.y - token / 2 }],
              };
            });
            animation = {
              animationName: frames,
              animationDuration: total,
              animationTimingFunction: 'linear',
            };
          }
        }
        return (
          <Animated.View
            key={`${seat}-${seat === mover ? last?.id : 'still'}`}
            accessibilityLabel={`${SNAKES_COLOR_NAMES[seat]} on ${square === 0 ? 'the start' : `square ${square}`}`}
            style={[
              {
                position: 'absolute',
                left: 0,
                top: 0,
                width: token,
                height: token,
                borderRadius: token / 2,
                backgroundColor: look.fill,
                borderWidth: 2,
                borderColor: look.ring,
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 4px rgba(0, 0, 0, 0.35)',
                transform: [{ translateX: end.x - token / 2 }, { translateY: end.y - token / 2 }],
                zIndex: seat === mover ? 2 : 1,
              },
              animation,
            ]}
          >
            <ShapeGlyph color={color} size={token * 0.5} fill={look.on} />
          </Animated.View>
        );
      })}
    </View>
  );
}
