// Ludo pieces over the board (ADR 0049, 0050): shaded pins that hop square by square in an arc
// and squash as they land, captured pieces flying home, stacks with a count, and pins the user
// may move bobbing over a pulsing ring. Positions come from `ludoStacks` in `@pingdost/games`.
import { memo, useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  Path,
  Polygon,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

import { Text } from '@/components/text';
import { CSS_EASE_IN_OUT } from '@/theme/motion';
import {
  HOME,
  LUDO_PIN,
  ludoStacks,
  pathPoints,
  pieceLabel,
  pointOf,
  rotatePoint,
  YARD,
  YARD_ORIGIN,
  type LudoColor,
  type LudoView,
  type Point,
} from '@pingdost/games';
import { gameBoardColors, gamePlayerShapes, type GamePlayerLook } from '@pingdost/ui-tokens';

const BOX = LUDO_PIN.box;
const PIN_SCALE = 1.25;

const BOB = {
  '0%': { transform: [{ translateY: 0 }] },
  '50%': { transform: [{ translateY: -4 }] },
  '100%': { transform: [{ translateY: 0 }] },
};
const RING_PULSE = {
  '0%': { transform: [{ scale: 0.85 }], opacity: 1 },
  '100%': { transform: [{ scale: 1.25 }], opacity: 0.15 },
};

/** The color-blind shape on the pin's white face, in pin coordinates. */
function FaceGlyph({ color, fill }: { color: LudoColor; fill: string }) {
  const { cx, cy } = LUDO_PIN.face;
  const h = LUDO_PIN.glyph / 2;
  switch (gamePlayerShapes[color]) {
    case 'circle':
      return <Circle cx={cx} cy={cy} r={h * 0.8} fill={fill} />;
    case 'square':
      return (
        <Rect
          x={cx - h * 0.7}
          y={cy - h * 0.7}
          width={h * 1.4}
          height={h * 1.4}
          rx={h * 0.15}
          fill={fill}
        />
      );
    case 'triangle':
      return (
        <Polygon
          points={`${cx},${cy - h * 0.85} ${cx + h * 0.85},${cy + h * 0.7} ${cx - h * 0.85},${cy + h * 0.7}`}
          fill={fill}
        />
      );
    case 'diamond':
      return (
        <Polygon
          points={`${cx},${cy - h} ${cx + h},${cy} ${cx},${cy + h} ${cx - h},${cy}`}
          fill={fill}
        />
      );
  }
}

/** One shaded pin, `size` pixels per cell. Static: the parent animates it. */
export const Pin = memo(function Pin({
  color,
  look,
  size,
}: {
  color: LudoColor;
  look: GamePlayerLook;
  size: number;
}) {
  const id = `pd-pin-${color}`;
  const { face, gloss, shadow } = LUDO_PIN;
  return (
    <Svg
      width={BOX.width * size}
      height={BOX.height * size}
      viewBox={`${BOX.x} ${BOX.y} ${BOX.width} ${BOX.height}`}
    >
      <Defs>
        <RadialGradient id={id} cx="35%" cy="30%" r="85%">
          <Stop offset="0" stopColor={look.light} />
          <Stop offset="0.55" stopColor={look.fill} />
          <Stop offset="1" stopColor={look.dark} />
        </RadialGradient>
      </Defs>
      <Ellipse
        cx={shadow.cx}
        cy={shadow.cy}
        rx={shadow.rx}
        ry={shadow.ry}
        fill="#000000"
        opacity={0.3}
      />
      <Path d={LUDO_PIN.path} fill={`url(#${id})`} stroke={look.ring} strokeWidth={0.035} />
      <Circle cx={face.cx} cy={face.cy} r={face.r} fill="#FFFFFF" opacity={0.96} />
      <FaceGlyph color={color} fill={look.fill} />
      <Ellipse
        cx={gloss.cx}
        cy={gloss.cy}
        rx={gloss.rx}
        ry={gloss.ry}
        fill="#FFFFFF"
        opacity={0.5}
      />
    </Svg>
  );
});

interface Hop {
  id: number;
  /** Board points to pass through, in cell units, before turning the board. */
  points: Point[];
  delay: number;
  ms: number;
  /** How high the arc goes, in cells. */
  lift: number;
}

interface PieceProps {
  color: LudoColor;
  token: number;
  progress: number;
  /** Where it rests: cell units, turned, with its stack offset. */
  x: number;
  y: number;
  scale: number;
  layer: number;
  count: number;
  top: boolean;
  cell: number;
  rotation: number;
  hop: Hop | null;
  /** When a piece lands on this stack: the moment to pop. */
  popDelay: number;
  movable: boolean;
  onPress: (token: number) => void;
  dark: boolean;
  moves: boolean;
}

const Piece = memo(function Piece({
  color,
  token,
  progress,
  x: restX,
  y: restY,
  scale,
  layer,
  count,
  top,
  cell,
  rotation,
  hop,
  popDelay,
  movable,
  onPress,
  dark,
  moves,
}: PieceProps) {
  const look = gameBoardColors(dark).players[color];
  // Pins a little larger than their square, so they read as standing on it.
  const size = cell * scale * PIN_SCALE;
  const width = BOX.width * size;
  const height = BOX.height * size;
  const x = useSharedValue(restX * cell);
  const y = useSharedValue(restY * cell);
  const arc = useSharedValue(0);
  const squash = useSharedValue(1);
  const pop = useSharedValue(1);
  // The hop object is new on every render; only a new hop ID starts an animation.
  const latestHop = useRef(hop);
  latestHop.current = hop;
  const handled = useRef<number | null>(hop?.id ?? null);
  const hopId = hop?.id ?? null;
  const lastCount = useRef(count);

  useEffect(() => {
    const targetX = restX * cell;
    const targetY = restY * cell;
    const next = latestHop.current;
    if (next && next.id !== handled.current && next.points.length > 0 && moves) {
      handled.current = next.id;
      const pts = next.points.map((p) => rotatePoint(p, rotation));
      // The last square is where it rests (with its stack offset).
      const xs = pts.map((p, i) => (i === pts.length - 1 ? targetX : p.x * cell));
      const ys = pts.map((p, i) => (i === pts.length - 1 ? targetY : p.y * cell));
      const glide = { duration: next.ms, easing: Easing.inOut(Easing.quad) };
      const up = { duration: next.ms / 2, easing: Easing.out(Easing.quad) };
      const down = { duration: next.ms / 2, easing: Easing.in(Easing.quad) };
      x.value = withDelay(next.delay, withSequence(...xs.map((v) => withTiming(v, glide))));
      y.value = withDelay(next.delay, withSequence(...ys.map((v) => withTiming(v, glide))));
      arc.value = withDelay(
        next.delay,
        withSequence(
          ...pts.flatMap(() => [withTiming(-next.lift * cell, up), withTiming(0, down)]),
        ),
      );
      squash.value = withDelay(
        next.delay,
        withSequence(
          ...pts.flatMap(() => [
            withTiming(1.06, { duration: next.ms * 0.6 }),
            withTiming(0.8, { duration: next.ms * 0.22 }),
            withTiming(1, { duration: next.ms * 0.18 }),
          ]),
        ),
      );
      return;
    }
    if (next) handled.current = next.id;
    // Calm and Off: pieces jump; a stack settling slides a little at Full.
    x.value = moves ? withTiming(targetX, { duration: 160 }) : targetX;
    y.value = moves ? withTiming(targetY, { duration: 160 }) : targetY;
  }, [hopId, restX, restY, cell, rotation, moves, x, y, arc, squash]);

  // A piece landing on this stack makes it pop.
  useEffect(() => {
    if (count > lastCount.current && moves) {
      pop.value = withDelay(
        popDelay,
        withSequence(withTiming(1.2, { duration: 110 }), withTiming(1, { duration: 170 })),
      );
    }
    lastCount.current = count;
  }, [count, moves, popDelay, pop]);

  const position = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value + BOX.x * size },
      { translateY: y.value + arc.value + BOX.y * size },
      { scale: pop.value },
    ],
  }));
  const body = useAnimatedStyle(() => ({ transform: [{ scaleY: squash.value }] }));

  const moving = hop !== null && hop.id === handled.current;
  const slop = Math.max(0, (44 - width) / 2);
  const ring = LUDO_PIN.ring;
  const badge = Math.max(15, size * 0.36);
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        {
          position: 'absolute',
          left: 0,
          top: 0,
          width,
          height,
          zIndex: Math.round(restY * 10) + layer + (movable ? 500 : 0) + (moving ? 1000 : 0),
        },
        position,
      ]}
    >
      {movable && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: (ring.cx - ring.rx - BOX.x) * size,
            top: (ring.cy - ring.ry - BOX.y) * size,
            width: ring.rx * 2 * size,
            height: ring.ry * 2 * size,
            borderRadius: ring.rx * size,
            borderWidth: Math.max(2, size * 0.06),
            borderColor: look.ring,
            ...(moves
              ? {
                  animationName: RING_PULSE,
                  animationDuration: 900,
                  animationIterationCount: 'infinite',
                }
              : {}),
          }}
        />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${pieceLabel(color, token, progress)}${count > 1 ? `, ${count} stacked` : ''}`}
        accessibilityHint={movable ? 'Moves this piece' : undefined}
        accessibilityState={{ disabled: !movable }}
        disabled={!movable}
        hitSlop={slop}
        onPress={() => onPress(token)}
      >
        <Animated.View
          style={[
            { transformOrigin: 'bottom' },
            body,
            movable && moves
              ? {
                  animationName: BOB,
                  animationDuration: 700,
                  animationIterationCount: 'infinite',
                  animationTimingFunction: CSS_EASE_IN_OUT,
                }
              : null,
          ]}
        >
          <Pin color={color} look={look} size={size} />
        </Animated.View>
      </Pressable>
      {top && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: (0.2 - BOX.x) * size - badge / 2,
            top: (-0.38 - BOX.y) * size - badge / 2,
            minWidth: badge,
            height: badge,
            borderRadius: badge / 2,
            paddingHorizontal: 2,
            backgroundColor: '#FFFFFF',
            borderWidth: 1.5,
            borderColor: look.ring,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            style={{
              color: look.ring,
              fontSize: badge * 0.62,
              lineHeight: badge * 0.8,
              fontWeight: '800',
            }}
          >
            {count}
          </Text>
        </View>
      )}
    </Animated.View>
  );
});

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
  const moverHops = lastMove ? (lastMove.from === YARD ? 1 : lastMove.to - lastMove.from) : 0;

  const hopFor = (seat: number, token: number, color: LudoColor): Hop | null => {
    if (!lastMove) return null;
    if (lastMove.seat === seat && lastMove.token === token) {
      return {
        id: lastMove.id,
        points: pathPoints(color, token, lastMove.from, lastMove.to),
        delay: 0,
        ms: hopMs,
        lift: lastMove.to >= HOME ? 0.5 : 0.38,
      };
    }
    if (lastMove.captures.some((c) => c.seat === seat && c.token === token)) {
      return {
        id: lastMove.id,
        points: [pointOf(color, token, YARD)],
        delay: moverHops * hopMs,
        ms: captureMs,
        lift: 1.2,
      };
    }
    return null;
  };

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, top: 0, width: size, height: size }}
    >
      {ludoStacks(state, rotation).map((piece) => (
        <Piece
          key={`${piece.color}${piece.token}`}
          color={piece.color}
          token={piece.token}
          progress={piece.progress}
          x={piece.x}
          y={piece.y}
          scale={piece.scale}
          layer={piece.layer}
          count={piece.count}
          top={piece.top}
          cell={cell}
          rotation={rotation}
          hop={hopFor(piece.seat, piece.token, piece.color)}
          popDelay={moverHops * hopMs}
          movable={
            piece.seat === you && piece.seat === state.current && movable.includes(piece.token)
          }
          onPress={onMove}
          dark={dark}
          moves={moves}
        />
      ))}
    </View>
  );
}

/** The active player's yard glows (ADR 0050); a steady outline at Calm and Off. */
export function YardGlow({
  color,
  size,
  rotation,
  dark,
  moves,
}: {
  color: LudoColor;
  size: number;
  rotation: number;
  dark: boolean;
  moves: boolean;
}) {
  const cell = size / 15;
  const look = gameBoardColors(dark).players[color];
  const [ox, oy] = YARD_ORIGIN[color];
  const center = rotatePoint({ x: ox + 3, y: oy + 3 }, rotation);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: (center.x - 3) * cell,
        top: (center.y - 3) * cell,
        width: 6 * cell,
        height: 6 * cell,
        borderRadius: cell * 0.5,
        borderWidth: Math.max(3, cell * 0.14),
        borderColor: look.light,
        boxShadow: `0 0 ${cell * 0.9}px ${cell * 0.3}px ${look.fill}`,
        ...(moves
          ? {
              animationName: {
                '0%': { opacity: 1 },
                '50%': { opacity: 0.45 },
                '100%': { opacity: 1 },
              },
              animationDuration: 1300,
              animationIterationCount: 'infinite',
              animationTimingFunction: CSS_EASE_IN_OUT,
            }
          : {}),
      }}
    />
  );
}
