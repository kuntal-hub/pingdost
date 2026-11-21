// The shape each player color carries next to its color (ADR 0049), for color-blind players.
// `size` is the glyph's width in the parent's units; it is drawn centered on (0, 0).
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
  const h = size / 2;
  switch (gamePlayerShapes[color]) {
    case 'circle':
      return <circle r={h * 0.72} fill={fill} />;
    case 'square':
      return (
        <rect
          x={-h * 0.66}
          y={-h * 0.66}
          width={h * 1.32}
          height={h * 1.32}
          rx={h * 0.16}
          fill={fill}
        />
      );
    case 'triangle':
      return (
        <polygon
          points={`0,${-h * 0.78} ${h * 0.82},${h * 0.7} ${-h * 0.82},${h * 0.7}`}
          fill={fill}
        />
      );
    case 'diamond':
      return (
        <polygon points={`0,${-h * 0.86} ${h * 0.86},0 0,${h * 0.86} ${-h * 0.86},0`} fill={fill} />
      );
  }
}

/** The glyph in its own small SVG, for lists and buttons. */
export function ShapeIcon({
  color,
  size,
  fill,
}: {
  color: GamePlayerColor;
  size: number;
  fill: string;
}) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="-5 -5 10 10">
      <ShapeGlyph color={color} size={10} fill={fill} />
    </svg>
  );
}
