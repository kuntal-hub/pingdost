// The Ludo board on the web (ADR 0049): the shared shapes from `@pingdost/games` as DOM SVG,
// turned so the player's color sits bottom left, with the pieces on top. Pieces slide square by
// square with CSS transitions (`pd-piece`); colors are SVG attributes, so the strict CSP holds.
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import {
  BOARD_CELLS,
  HOME,
  LUDO_BOARD_SHAPES,
  LUDO_LINE_WIDTH,
  LUDO_RING_WIDTH,
  pathPoints,
  pieceLabel,
  pointOf,
  resolveLudoPaint,
  rotatePoint,
  YARD,
  type LudoColor,
  type LudoView,
  type Point,
} from '@pingdost/games';
import { gameBoardColors, type GameBoardColors } from '@pingdost/ui-tokens';

import { ShapeGlyph } from '../shape';

const Board = memo(function Board({
  rotation,
  colors,
}: {
  rotation: number;
  colors: GameBoardColors;
}) {
  const paint = (name: Parameters<typeof resolveLudoPaint>[0]) => resolveLudoPaint(name, colors);
  const outline = { stroke: colors.line, strokeWidth: LUDO_LINE_WIDTH };
  return (
    <g transform={`rotate(${-90 * rotation} 7.5 7.5)`}>
      {LUDO_BOARD_SHAPES.map((shape, i) => {
        switch (shape.kind) {
          case 'rect':
            return (
              <rect
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
              <circle
                key={i}
                cx={shape.cx}
                cy={shape.cy}
                r={shape.r}
                fill={paint(shape.fill)}
                {...(shape.ring ? { stroke: paint(shape.ring), strokeWidth: LUDO_RING_WIDTH } : {})}
              />
            );
          case 'polygon':
            return (
              <polygon
                key={i}
                points={shape.points}
                fill={paint(shape.fill)}
                {...(shape.outlined ? outline : {})}
              />
            );
        }
      })}
    </g>
  );
});

interface Hop {
  id: number;
  points: Point[];
  delay: number;
  ms: number;
}

/** Where a piece is drawn: its resting point, or each square of a hop in turn. */
function useShownPoint(rest: Point, hop: Hop | null, rotation: number, animate: boolean): Point {
  const [shown, setShown] = useState(rest);
  const latest = useRef(hop);
  latest.current = hop;
  const handled = useRef<number | null>(hop?.id ?? null);
  const hopId = hop?.id ?? null;
  useEffect(() => {
    const next = latest.current;
    if (next && next.id !== handled.current && animate && next.points.length > 0) {
      handled.current = next.id;
      const timers = next.points.map((point, i) =>
        setTimeout(
          () => setShown(i === next.points.length - 1 ? rest : rotatePoint(point, rotation)),
          next.delay + i * next.ms,
        ),
      );
      return () => timers.forEach(clearTimeout);
    }
    if (next) handled.current = next.id;
    setShown(rest);
    // A new hop ID or resting point starts the next movement; the hop itself is read from a ref.
  }, [hopId, rest.x, rest.y, rotation, animate]);
  return shown;
}

interface PieceProps {
  color: LudoColor;
  token: number;
  progress: number;
  rest: Point;
  scale: number;
  rotation: number;
  hop: Hop | null;
  movable: boolean;
  colors: GameBoardColors;
  animate: boolean;
  onMove: (token: number) => void;
}

function Piece({
  color,
  token,
  progress,
  rest,
  scale,
  rotation,
  hop,
  movable,
  colors,
  animate,
  onMove,
}: PieceProps) {
  const shown = useShownPoint(rest, hop, rotation, animate);
  const look = colors.players[color];
  const r = 0.4 * scale;
  const press = () => movable && onMove(token);
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      press();
    }
  };
  return (
    <g
      className="pd-piece"
      style={{
        transform: `translate(${shown.x}px, ${shown.y}px)`,
        transitionDuration: `${hop?.ms ?? 160}ms`,
      }}
    >
      <g
        role="button"
        tabIndex={movable ? 0 : -1}
        aria-label={pieceLabel(color, token, progress)}
        aria-disabled={!movable}
        onClick={press}
        onKeyDown={keys}
        className={movable ? 'pd-piece-target cursor-pointer outline-none' : 'outline-none'}
      >
        {movable && <circle r={0.62} fill="transparent" />}
        {movable && (
          <circle
            r={r + 0.17}
            fill="none"
            stroke={look.ring}
            strokeWidth={0.09}
            className="pd-piece-pulse"
          />
        )}
        <circle
          r={r + 0.24}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.07}
          className="pd-piece-focus text-accent"
        />
        <circle r={r + 0.05} fill={colors.cell} />
        <circle r={r} fill={look.fill} stroke={look.ring} strokeWidth={0.09} />
        <ShapeGlyph color={color} size={r * 0.95} fill={look.on} />
      </g>
    </g>
  );
}

function stackLayout(count: number, index: number): { dx: number; dy: number; scale: number } {
  if (count <= 1) return { dx: 0, dy: 0, scale: 1 };
  if (count === 2) return { dx: index === 0 ? -0.17 : 0.17, dy: 0, scale: 0.74 };
  if (count <= 4) {
    const spots = [
      [-0.17, -0.17],
      [0.17, -0.17],
      [-0.17, 0.17],
      [0.17, 0.17],
    ] as const;
    const [dx, dy] = spots[index]!;
    return { dx, dy, scale: 0.68 };
  }
  const angle = (index / count) * Math.PI * 2;
  return { dx: Math.cos(angle) * 0.24, dy: Math.sin(angle) * 0.24, scale: 0.55 };
}

interface LudoBoardProps {
  view: LudoView;
  rotation: number;
  dark: boolean;
  animate: boolean;
  hopMs: number;
  captureMs: number;
  onMove: (token: number) => void;
}

export function LudoBoard({
  view,
  rotation,
  dark,
  animate,
  hopMs,
  captureMs,
  onMove,
}: LudoBoardProps) {
  const colors = gameBoardColors(dark);
  const { state, lastMove, movable, you } = view;

  const groups = new Map<string, string[]>();
  const rests = new Map<string, Point>();
  state.players.forEach((player) => {
    if (player.left) return;
    player.tokens.forEach((progress, token) => {
      const key = `${player.color}${token}`;
      const point = rotatePoint(pointOf(player.color, token, progress), rotation);
      rests.set(key, point);
      if (progress === YARD || progress >= HOME) return;
      const square = `${point.x},${point.y}`;
      groups.set(square, [...(groups.get(square) ?? []), key]);
    });
  });
  const offsets = new Map<string, { dx: number; dy: number; scale: number }>();
  for (const keys of groups.values()) {
    keys.forEach((key, index) => offsets.set(key, stackLayout(keys.length, index)));
  }

  const moverHops = lastMove ? (lastMove.from === YARD ? 1 : lastMove.to - lastMove.from) : 0;
  const hopFor = (seat: number, token: number, color: LudoColor): Hop | null => {
    if (!lastMove) return null;
    if (lastMove.seat === seat && lastMove.token === token) {
      return {
        id: lastMove.id,
        points: pathPoints(color, token, lastMove.from, lastMove.to),
        delay: 0,
        ms: hopMs,
      };
    }
    if (lastMove.captures.some((c) => c.seat === seat && c.token === token)) {
      return {
        id: lastMove.id,
        points: [pointOf(color, token, YARD)],
        delay: moverHops * hopMs,
        ms: captureMs,
      };
    }
    return null;
  };

  // Movable pieces last, so they draw on top of any piece sharing their square.
  const pieces = state.players.flatMap((player, seat) =>
    player.left
      ? []
      : player.tokens.map((progress, token) => ({
          player,
          seat,
          token,
          progress,
          movable: seat === you && seat === state.current && movable.includes(token),
        })),
  );
  pieces.sort((a, b) => Number(a.movable) - Number(b.movable));

  return (
    <svg
      viewBox={`0 0 ${BOARD_CELLS} ${BOARD_CELLS}`}
      role="group"
      aria-label="Ludo board"
      className="block aspect-square w-full select-none"
    >
      <Board rotation={rotation} colors={colors} />
      {pieces.map(({ player, seat, token, progress, movable: canMove }) => {
        const key = `${player.color}${token}`;
        const offset = offsets.get(key) ?? { dx: 0, dy: 0, scale: 1 };
        const rest = rests.get(key)!;
        return (
          <Piece
            key={key}
            color={player.color}
            token={token}
            progress={progress}
            rest={{ x: rest.x + offset.dx, y: rest.y + offset.dy }}
            scale={offset.scale}
            rotation={rotation}
            hop={hopFor(seat, token, player.color)}
            movable={canMove}
            colors={colors}
            animate={animate}
            onMove={onMove}
          />
        );
      })}
    </svg>
  );
}
