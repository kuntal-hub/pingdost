// The shape each player color carries next to its color (ADR 0049), for color-blind players.
import Svg, { Circle, Polygon, Rect } from 'react-native-svg';

import { gamePlayerShapes, type GamePlayerColor } from '@pingdost/ui-tokens';

export function ShapeGlyph({
  color,
  size,
  fill,
}: {
  color: GamePlayerColor;
  size: number;
  fill: string;
}) {
  const shape = gamePlayerShapes[color];
  return (
    <Svg width={size} height={size} viewBox="0 0 10 10">
      {shape === 'circle' && <Circle cx={5} cy={5} r={3.4} fill={fill} />}
      {shape === 'square' && <Rect x={1.8} y={1.8} width={6.4} height={6.4} rx={0.8} fill={fill} />}
      {shape === 'triangle' && <Polygon points="5,1.2 9,8.6 1,8.6" fill={fill} />}
      {shape === 'diamond' && <Polygon points="5,0.8 9.2,5 5,9.2 0.8,5" fill={fill} />}
    </Svg>
  );
}
