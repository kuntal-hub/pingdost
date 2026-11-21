// The Ludo board (ADR 0049): the shared shapes from `@pingdost/games`, drawn once with
// react-native-svg and turned so the player's color sits bottom left. Pieces are separate views
// on top (pieces.tsx).
import { memo } from 'react';
import Svg, { Circle, G, Polygon, Rect } from 'react-native-svg';

import {
  BOARD_CELLS,
  LUDO_BOARD_SHAPES,
  LUDO_LINE_WIDTH,
  LUDO_RING_WIDTH,
  resolveLudoPaint,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

interface LudoBoardProps {
  size: number;
  /** Counterclockwise quarter turns (`rotationFor` the player's color). */
  rotation: number;
  dark: boolean;
}

export const LudoBoard = memo(function LudoBoard({ size, rotation, dark }: LudoBoardProps) {
  const colors = gameBoardColors(dark);
  const paint = (name: Parameters<typeof resolveLudoPaint>[0]) => resolveLudoPaint(name, colors);
  const outline = { stroke: colors.line, strokeWidth: LUDO_LINE_WIDTH };
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${BOARD_CELLS} ${BOARD_CELLS}`}>
      <G transform={`rotate(${-90 * rotation} 7.5 7.5)`}>
        {LUDO_BOARD_SHAPES.map((shape, i) => {
          switch (shape.kind) {
            case 'rect':
              return (
                <Rect
                  key={i}
                  x={shape.x}
                  y={shape.y}
                  width={shape.width}
                  height={shape.height}
                  rx={shape.rx}
                  fill={paint(shape.fill)}
                  {...(shape.outlined ? outline : {})}
                />
              );
            case 'circle':
              return (
                <Circle
                  key={i}
                  cx={shape.cx}
                  cy={shape.cy}
                  r={shape.r}
                  fill={paint(shape.fill)}
                  {...(shape.ring
                    ? { stroke: paint(shape.ring), strokeWidth: LUDO_RING_WIDTH }
                    : {})}
                />
              );
            case 'polygon':
              return (
                <Polygon
                  key={i}
                  points={shape.points}
                  fill={paint(shape.fill)}
                  {...(shape.outlined ? outline : {})}
                />
              );
          }
        })}
      </G>
    </Svg>
  );
});
