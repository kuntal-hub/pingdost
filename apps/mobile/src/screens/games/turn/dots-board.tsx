// Dots and Boxes on the phone (Phase 43): dots, the lines drawn in each player's color, and
// closed boxes tinted with their owner's color and shape. On the user's turn every open line is a
// faint dashed hint with a generous tap area. The newest line draws itself; new boxes pop in.
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle, Line } from 'react-native-svg';

import { Tap } from '@/components/tap';
import { CSS_EASE_OUT, CSS_POP } from '@/theme/motion';
import {
  DOTS_COLOR_NAMES,
  DOTS_COLORS,
  dotsGeometry,
  dotsLineAt,
  type DotsMove,
  type DotsState,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { POP_IN, type TurnBoardProps } from './board-props';
import { ShapeGlyph } from '../shape';

export function DotsBoard({
  state,
  legal,
  last,
  onMove,
  size,
  dark,
  moves,
  pace,
}: TurnBoardProps<DotsState, DotsMove>) {
  const colors = gameBoardColors(dark);
  const n = state.settings.size;
  const geo = dotsGeometry(n);
  const pad = Math.max(16, size * 0.06);
  const gap = (size - pad * 2) / n;
  const stroke = Math.max(4, gap * 0.11);
  const open = new Set(legal.map((m) => m.line));
  const lastLine = last?.move?.line;
  const fresh = new Set(
    last?.move !== undefined && last.before
      ? state.boxes.flatMap((owner, box) =>
          owner >= 0 && last.before.boxes[box] === -1 ? [box] : [],
        )
      : [],
  );
  const ends = (line: number) => {
    const at = dotsLineAt(n, line);
    const x1 = pad + at.col * gap;
    const y1 = pad + at.row * gap;
    return at.horizontal ? { x1, y1, x2: x1 + gap, y2: y1 } : { x1, y1, x2: x1, y2: y1 + gap };
  };

  return (
    <View style={{ width: size, height: size, borderRadius: 20, backgroundColor: colors.board }}>
      {state.boxes.map((owner, box) => {
        if (owner < 0) return null;
        const color = DOTS_COLORS[owner] ?? 'red';
        const look = colors.players[color];
        const r = Math.floor(box / n);
        const c = box % n;
        return (
          <Animated.View
            key={`${box}-${fresh.has(box) ? last?.id : 'old'}`}
            accessibilityLabel={`Box closed by ${DOTS_COLOR_NAMES[owner]}`}
            style={[
              {
                position: 'absolute',
                left: pad + c * gap + stroke / 2,
                top: pad + r * gap + stroke / 2,
                width: gap - stroke,
                height: gap - stroke,
                borderRadius: 6,
                backgroundColor: look.soft,
                alignItems: 'center',
                justifyContent: 'center',
              },
              fresh.has(box) && moves
                ? {
                    animationName: POP_IN,
                    animationDuration: pace.step + 120,
                    animationTimingFunction: CSS_POP,
                  }
                : {},
            ]}
          >
            <ShapeGlyph color={color} size={gap * 0.42} fill={look.fill} />
          </Animated.View>
        );
      })}
      <Svg width={size} height={size} style={{ position: 'absolute' }} pointerEvents="none">
        {state.lines.map((owner, line) => {
          if (owner >= 0 || !open.has(line)) return null;
          const e = ends(line);
          return (
            <Line
              key={line}
              {...e}
              stroke={colors.dot}
              strokeOpacity={0.28}
              strokeWidth={stroke * 0.5}
              strokeDasharray={`${stroke} ${stroke}`}
              strokeLinecap="round"
            />
          );
        })}
        {state.lines.map((owner, line) => {
          if (owner < 0 || line === lastLine) return null;
          const e = ends(line);
          const look = colors.players[DOTS_COLORS[owner] ?? 'red'];
          return (
            <Line key={line} {...e} stroke={look.fill} strokeWidth={stroke} strokeLinecap="round" />
          );
        })}
      </Svg>
      {lastLine !== undefined &&
        state.lines[lastLine]! >= 0 &&
        (() => {
          const e = ends(lastLine);
          const horizontal = e.y1 === e.y2;
          const look = colors.players[DOTS_COLORS[state.lines[lastLine]!] ?? 'red'];
          return (
            <Animated.View
              key={`line${last?.id}`}
              pointerEvents="none"
              style={[
                {
                  position: 'absolute',
                  left: Math.min(e.x1, e.x2) - stroke / 2,
                  top: Math.min(e.y1, e.y2) - stroke / 2,
                  width: horizontal ? gap + stroke : stroke,
                  height: horizontal ? stroke : gap + stroke,
                  borderRadius: stroke / 2,
                  backgroundColor: look.fill,
                  boxShadow: `0 0 0 2px ${look.ring}`,
                },
                moves
                  ? {
                      animationName: horizontal
                        ? {
                            from: { transform: [{ scaleX: 0 }] },
                            to: { transform: [{ scaleX: 1 }] },
                          }
                        : {
                            from: { transform: [{ scaleY: 0 }] },
                            to: { transform: [{ scaleY: 1 }] },
                          },
                      animationDuration: pace.step,
                      animationTimingFunction: CSS_EASE_OUT,
                    }
                  : {},
              ]}
            />
          );
        })()}
      <Svg width={size} height={size} style={{ position: 'absolute' }} pointerEvents="none">
        {Array.from({ length: (n + 1) * (n + 1) }, (_, i) => (
          <Circle
            key={i}
            cx={pad + (i % (n + 1)) * gap}
            cy={pad + Math.floor(i / (n + 1)) * gap}
            r={stroke * 0.85}
            fill={colors.dot}
          />
        ))}
      </Svg>
      {Array.from({ length: geo.lineCount }, (_, line) => {
        if (!open.has(line)) return null;
        const at = dotsLineAt(n, line);
        const e = ends(line);
        const reach = Math.min(44, gap * 0.8);
        return (
          <Tap
            key={line}
            accessibilityRole="button"
            accessibilityLabel={`${at.horizontal ? 'Line across' : 'Line down'}, row ${at.row + 1}, column ${at.col + 1}`}
            feedback="light"
            onPress={() => onMove({ line })}
            style={{
              position: 'absolute',
              left: at.horizontal ? e.x1 + gap * 0.18 : e.x1 - reach / 2,
              top: at.horizontal ? e.y1 - reach / 2 : e.y1 + gap * 0.18,
              width: at.horizontal ? gap * 0.64 : reach,
              height: at.horizontal ? reach : gap * 0.64,
            }}
          />
        );
      })}
    </View>
  );
}
