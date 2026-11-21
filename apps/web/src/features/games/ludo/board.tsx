// The Ludo board on the web (ADR 0049, 0050): the shared shapes from `@pingdost/games` as DOM
// SVG, turned so the player's color sits bottom left, with shaded pins on top. A hop is one CSS
// transition per square plus an arc (`pd-hop`); stacks carry a count; the active yard glows.
// Colors are SVG attributes and React styles (CSSOM), so the strict CSP holds.
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import {
  BOARD_CELLS,
  LUDO_BOARD_SHAPES,
  LUDO_COLORS,
  LUDO_LINE_WIDTH,
  LUDO_PIN,
  LUDO_RING_WIDTH,
  ludoStacks,
  pathPoints,
  pieceLabel,
  pointOf,
  resolveLudoPaint,
  rotatePoint,
  YARD,
  YARD_ORIGIN,
  type LudoColor,
  type LudoView,
  type Point,
} from '@pingdost/games';
import { gameBoardColors, type GameBoardColors } from '@pingdost/ui-tokens';

import { ShapeGlyph } from '../shape';

/** Pins a little larger than their square, so they read as standing on it. */
const PIN_SCALE = 1.25;

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

/** One radial gradient per color, shared by every pin. */
function PinGradients({ colors }: { colors: GameBoardColors }) {
  const { cx, cy, r } = LUDO_PIN.gradient;
  return (
    <defs>
      {LUDO_COLORS.map((color) => {
        const look = colors.players[color];
        return (
          <radialGradient key={color} id={`pd-pin-${color}`} cx={cx} cy={cy} r={r}>
            <stop offset="0" stopColor={look.light} />
            <stop offset="0.55" stopColor={look.fill} />
            <stop offset="1" stopColor={look.dark} />
          </radialGradient>
        );
      })}
    </defs>
  );
}

interface Hop {
  id: number;
  points: Point[];
  delay: number;
  ms: number;
  /** A capture flies home in one high arc. */
  fly: boolean;
}

/** Where a piece is drawn: its resting point, or each square of a hop in turn. */
function useShownPoint(
  rest: Point,
  hop: Hop | null,
  rotation: number,
  animate: boolean,
): { point: Point; step: number } {
  const [shown, setShown] = useState({ point: rest, step: 0 });
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
          () =>
            setShown((current) => ({
              point: i === next.points.length - 1 ? rest : rotatePoint(point, rotation),
              step: current.step + 1,
            })),
          next.delay + i * next.ms,
        ),
      );
      return () => timers.forEach(clearTimeout);
    }
    if (next) handled.current = next.id;
    setShown((current) => ({ point: rest, step: current.step }));
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
  count: number;
  top: boolean;
  rotation: number;
  hop: Hop | null;
  popDelay: number;
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
  count,
  top,
  rotation,
  hop,
  popDelay,
  movable,
  colors,
  animate,
  onMove,
}: PieceProps) {
  const shown = useShownPoint(rest, hop, rotation, animate);
  const look = colors.players[color];
  const s = scale * PIN_SCALE;
  const { face, gloss, shadow, ring } = LUDO_PIN;
  // A piece landing on this stack makes it pop.
  const [popKey, setPopKey] = useState(0);
  const lastCount = useRef(count);
  useEffect(() => {
    if (count > lastCount.current) setPopKey((key) => key + 1);
    lastCount.current = count;
  }, [count]);
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
        transform: `translate(${shown.point.x}px, ${shown.point.y}px)`,
        transitionDuration: `${hop?.ms ?? 160}ms`,
      }}
    >
      <g
        role="button"
        tabIndex={movable ? 0 : -1}
        aria-label={`${pieceLabel(color, token, progress)}${count > 1 ? `, ${count} stacked` : ''}`}
        aria-disabled={!movable}
        onClick={press}
        onKeyDown={keys}
        className={movable ? 'pd-piece-target cursor-pointer outline-none' : 'outline-none'}
      >
        {movable && <circle r={0.62} fill="transparent" />}
        {movable && (
          <ellipse
            cx={ring.cx * s}
            cy={ring.cy * s}
            rx={ring.rx * s}
            ry={ring.ry * s}
            fill="none"
            stroke={look.ring}
            strokeWidth={0.07}
            className="pd-piece-pulse"
          />
        )}
        <circle
          cy={-0.1 * s}
          r={0.5 * s}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.07}
          className="pd-piece-focus text-accent"
        />
        <g
          key={`pop${popKey}`}
          className={popKey > 0 ? 'pd-stack-pop' : undefined}
          style={{ animationDelay: `${popDelay}ms` }}
        >
          <g
            key={`hop${shown.step}`}
            className={shown.step > 0 && animate ? (hop?.fly ? 'pd-fly' : 'pd-hop') : undefined}
            style={{ animationDuration: `${hop?.ms ?? 170}ms` }}
          >
            <g className={movable ? 'pd-bob' : undefined}>
              <g transform={`scale(${s})`}>
                <ellipse
                  cx={shadow.cx}
                  cy={shadow.cy}
                  rx={shadow.rx}
                  ry={shadow.ry}
                  fill="#000000"
                  opacity={0.3}
                />
                <path
                  d={LUDO_PIN.path}
                  fill={`url(#pd-pin-${color})`}
                  stroke={look.ring}
                  strokeWidth={0.035}
                />
                <circle cx={face.cx} cy={face.cy} r={face.r} fill="#FFFFFF" opacity={0.96} />
                <g transform={`translate(${face.cx} ${face.cy})`}>
                  <ShapeGlyph color={color} size={LUDO_PIN.glyph} fill={look.fill} />
                </g>
                <ellipse
                  cx={gloss.cx}
                  cy={gloss.cy}
                  rx={gloss.rx}
                  ry={gloss.ry}
                  fill="#FFFFFF"
                  opacity={0.5}
                />
              </g>
            </g>
          </g>
        </g>
        {top && (
          <g transform={`translate(${0.24 * s} ${-0.42 * s})`} aria-hidden>
            <circle r={0.25} fill="#FFFFFF" stroke={look.ring} strokeWidth={0.05} />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={0.32}
              fontWeight={800}
              fill={look.ring}
            >
              {count}
            </text>
          </g>
        )}
      </g>
    </g>
  );
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
  const { state, lastMove, movable, you, waiting } = view;
  const moverHops = lastMove ? (lastMove.from === YARD ? 1 : lastMove.to - lastMove.from) : 0;
  const hopFor = (seat: number, token: number, color: LudoColor): Hop | null => {
    if (!lastMove) return null;
    if (lastMove.seat === seat && lastMove.token === token) {
      return {
        id: lastMove.id,
        points: pathPoints(color, token, lastMove.from, lastMove.to),
        delay: 0,
        ms: hopMs,
        fly: false,
      };
    }
    if (lastMove.captures.some((c) => c.seat === seat && c.token === token)) {
      return {
        id: lastMove.id,
        points: [pointOf(color, token, YARD)],
        delay: moverHops * hopMs,
        ms: captureMs,
        fly: true,
      };
    }
    return null;
  };

  // Back to front: lower on the board draws later; movable pins last of all.
  const pieces = ludoStacks(state, rotation)
    .map((piece) => ({
      ...piece,
      movable: piece.seat === you && piece.seat === state.current && movable.includes(piece.token),
    }))
    .sort((a, b) => Number(a.movable) - Number(b.movable) || a.y - b.y || a.layer - b.layer);

  const active = waiting === 'over' ? null : state.players[state.current]!;
  const glow =
    active &&
    (() => {
      const [ox, oy] = YARD_ORIGIN[active.color];
      const center = rotatePoint({ x: ox + 3, y: oy + 3 }, rotation);
      return {
        color: active.color,
        x: center.x - 2.95,
        y: center.y - 2.95,
        look: colors.players[active.color],
      };
    })();

  return (
    <svg
      viewBox={`0 0 ${BOARD_CELLS} ${BOARD_CELLS}`}
      role="group"
      aria-label="Ludo board"
      className="block aspect-square w-full select-none"
    >
      <PinGradients colors={colors} />
      <Board rotation={rotation} colors={colors} />
      {glow && (
        <rect
          key={glow.color}
          x={glow.x}
          y={glow.y}
          width={5.9}
          height={5.9}
          rx={0.5}
          fill="none"
          stroke={glow.look.light}
          strokeWidth={0.16}
          className="pd-yard-glow"
          style={{ filter: `drop-shadow(0 0 0.35px ${glow.look.fill})` }}
        />
      )}
      {pieces.map((piece) => (
        <Piece
          key={`${piece.color}${piece.token}`}
          color={piece.color}
          token={piece.token}
          progress={piece.progress}
          rest={{ x: piece.x, y: piece.y }}
          scale={piece.scale}
          count={piece.count}
          top={piece.top}
          rotation={rotation}
          hop={hopFor(piece.seat, piece.token, piece.color)}
          popDelay={moverHops * hopMs}
          movable={piece.movable}
          colors={colors}
          animate={animate}
          onMove={onMove}
        />
      ))}
    </svg>
  );
}
