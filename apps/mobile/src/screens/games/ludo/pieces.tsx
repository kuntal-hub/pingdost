// Ludo pieces over the board: Reanimated hops square by square, captured pieces fly home, and
// pieces the user may move pulse (ADR 0049). Positions come from `@pingdost/games` geometry.
import { memo, useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { CSS_EASE_IN_OUT, EASE_OUT } from '@/theme/motion';
import {
  HOME,
  pathPoints,
  pieceLabel,
  pointOf,
  rotatePoint,
  YARD,
  type LudoColor,
  type LudoView,
  type Point,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { ShapeGlyph } from '../shape';

const PULSE = {
  '0%': { transform: [{ scale: 1 }] },
  '50%': { transform: [{ scale: 1.16 }] },
  '100%': { transform: [{ scale: 1 }] },
};

interface Hop {
  id: number;
  /** Board points to pass through, in cell units, before rotation. */
  points: Point[];
  delay: number;
  ms: number;
}

interface PieceProps {
  color: LudoColor;
  token: number;
  progress: number;
  /** Where it rests: board point in cell units, rotated, with any stack offset. */
  rest: Point;
  scale: number;
  cell: number;
  rotation: number;
  hop: Hop | null;
  movable: boolean;
  onPress: (token: number) => void;
  dark: boolean;
  moves: boolean;
}

const Piece = memo(function Piece({
  color,
  token,
  progress,
  rest,
  scale,
  cell,
  rotation,
  hop,
  movable,
  onPress,
  dark,
  moves,
}: PieceProps) {
  const look = gameBoardColors(dark).players[color];
  const halo = gameBoardColors(dark).cell;
  const size = cell * 0.84 * scale;
  const x = useSharedValue(rest.x * cell);
  const y = useSharedValue(rest.y * cell);
  const lift = useSharedValue(1);
  // The hop object is new on every render; only a new hop ID starts an animation.
  const latestHop = useRef(hop);
  latestHop.current = hop;
  const handled = useRef<number | null>(hop?.id ?? null);
  const hopId = hop?.id ?? null;

  useEffect(() => {
    const targetX = rest.x * cell;
    const targetY = rest.y * cell;
    const next = latestHop.current;
    if (next && next.id !== handled.current && next.points.length > 0 && moves) {
      handled.current = next.id;
      const pts = next.points.map((p) => rotatePoint(p, rotation));
      // The last square is where it rests (with any stack offset).
      const xs = pts.map((p, i) => (i === pts.length - 1 ? targetX : p.x * cell));
      const ys = pts.map((p, i) => (i === pts.length - 1 ? targetY : p.y * cell));
      const step = { duration: next.ms, easing: EASE_OUT };
      const half = { duration: next.ms / 2 };
      x.value = withDelay(next.delay, withSequence(...xs.map((v) => withTiming(v, step))));
      y.value = withDelay(next.delay, withSequence(...ys.map((v) => withTiming(v, step))));
      lift.value = withDelay(
        next.delay,
        withSequence(...pts.flatMap(() => [withTiming(1.22, half), withTiming(1, half)])),
      );
      return;
    }
    if (next) handled.current = next.id;
    // Calm and Off: pieces jump; a stack settling slides a little at Full.
    x.value = moves ? withTiming(targetX, { duration: 160 }) : targetX;
    y.value = moves ? withTiming(targetY, { duration: 160 }) : targetY;
  }, [hopId, rest.x, rest.y, cell, rotation, moves, x, y, lift]);

  const position = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value - size / 2 },
      { translateY: y.value - size / 2 },
      { scale: lift.value },
    ],
  }));

  const slop = Math.max(0, (44 - size) / 2);
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        {
          position: 'absolute',
          left: 0,
          top: 0,
          width: size,
          height: size,
          zIndex: movable ? 3 : progress === YARD || progress >= HOME ? 1 : 2,
        },
        position,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={pieceLabel(color, token, progress)}
        accessibilityHint={movable ? 'Moves this piece' : undefined}
        accessibilityState={{ disabled: !movable }}
        disabled={!movable}
        hitSlop={slop}
        onPress={() => onPress(token)}
      >
        <Animated.View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: look.fill,
            borderWidth: Math.max(2, size * 0.12),
            borderColor: look.ring,
            alignItems: 'center',
            justifyContent: 'center',
            // A thin outline in the cell color keeps a piece apart from a colored square.
            boxShadow: `0 0 0 ${Math.max(1, size * 0.06)}px ${halo}${movable ? `, 0 0 0 ${Math.max(3, size * 0.18)}px ${look.ring}` : ''}`,
            ...(movable && moves
              ? {
                  animationName: PULSE,
                  animationDuration: 900,
                  animationIterationCount: 'infinite',
                  animationTimingFunction: CSS_EASE_IN_OUT,
                }
              : {}),
          }}
        >
          <ShapeGlyph color={color} size={size * 0.46} fill={look.on} />
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
});

/** Small offsets (cell units) and a scale for pieces sharing one square. */
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

interface PiecesProps {
  view: LudoView;
  size: number;
  rotation: number;
  dark: boolean;
  moves: boolean;
  hopMs: number;
  captureMs: number;
  onMove: (token: number) => void;
}

/** Every piece of every player, positioned over a board of `size` pixels. */
export function LudoPieces({
  view,
  size,
  rotation,
  dark,
  moves,
  hopMs,
  captureMs,
  onMove,
}: PiecesProps) {
  const cell = size / 15;
  const { state, lastMove, movable, you } = view;

  // Group pieces standing on the same square, so they can sit side by side.
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

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, top: 0, width: size, height: size }}
    >
      {state.players.map((player, seat) =>
        player.left
          ? null
          : player.tokens.map((progress, token) => {
              const key = `${player.color}${token}`;
              const offset = offsets.get(key) ?? { dx: 0, dy: 0, scale: 1 };
              const rest = rests.get(key)!;
              const mine = seat === you && seat === state.current;
              return (
                <Piece
                  key={key}
                  color={player.color}
                  token={token}
                  progress={progress}
                  rest={{ x: rest.x + offset.dx, y: rest.y + offset.dy }}
                  scale={offset.scale}
                  cell={cell}
                  rotation={rotation}
                  hop={hopFor(seat, token, player.color)}
                  movable={mine && movable.includes(token)}
                  onPress={onMove}
                  dark={dark}
                  moves={moves}
                />
              );
            }),
      )}
    </View>
  );
}
