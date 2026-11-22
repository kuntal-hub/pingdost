// Chess on the phone (Phase 44): the board turned so the user's side is at the bottom, tap a
// piece then a square (or drag it), dots for the moves it has, rings for captures, the last move
// and a king in check tinted, a picker when a pawn promotes, and the moved piece sliding in.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, PanResponder, View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { CSS_EASE_OUT } from '@/theme/motion';
import {
  BISHOP,
  chessPosition,
  chessSideOf,
  KNIGHT,
  PIECE_BOX,
  PIECE_EDGE_WIDTH,
  PIECE_LINE_WIDTH,
  PIECE_NAMES,
  PIECE_SHAPES,
  QUEEN,
  ROOK,
  squareName,
  type ChessMove,
  type ChessState,
} from '@pingdost/games';
import { gameBoardColors, type ChessColors } from '@pingdost/ui-tokens';

import type { TurnBoardProps } from './board-props';

type Ply = { from: number; to: number; promotion?: number };

export const ChessPiece = memo(function ChessPiece({
  piece,
  size,
  colors,
}: {
  piece: number;
  size: number;
  colors: ChessColors;
}) {
  const look = piece > 0 ? colors.white : colors.black;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${PIECE_BOX} ${PIECE_BOX}`}>
      {PIECE_SHAPES[Math.abs(piece)]!.map((shape, i) =>
        shape.kind === 'fill' ? (
          <Path
            key={i}
            d={shape.d}
            fill={look.fill}
            stroke={look.edge}
            strokeWidth={PIECE_EDGE_WIDTH}
            strokeLinejoin="round"
          />
        ) : shape.kind === 'dot' ? (
          <Path key={i} d={shape.d} fill={look.detail} />
        ) : (
          <Path
            key={i}
            d={shape.d}
            fill="none"
            stroke={look.detail}
            strokeWidth={PIECE_LINE_WIDTH}
            strokeLinecap="round"
          />
        ),
      )}
    </Svg>
  );
});

const PROMOTIONS = [QUEEN, ROOK, BISHOP, KNIGHT];

function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setOn);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => subscription.remove();
  }, []);
  return on;
}

export function ChessBoard({
  state,
  you,
  legal,
  last,
  onMove,
  size,
  dark,
  moves,
  pace,
}: TurnBoardProps<ChessState, ChessMove>) {
  const colors = gameBoardColors(dark).chess;
  const cell = size / 8;
  const whiteBottom = you < 0 || chessSideOf(state, you) === 'white';
  const position = useMemo(() => chessPosition(state), [state.fen]);
  const plies = legal.filter((m): m is Ply => !('acceptDraw' in m));
  const [selected, setSelected] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number } | null>(null);
  // With a screen reader each square is a button; otherwise one responder handles taps and drags.
  const screenReader = useScreenReader();
  // A new position clears any half-made move.
  const seenFen = useRef(state.fen);
  if (seenFen.current !== state.fen) {
    seenFen.current = state.fen;
    if (selected !== null) setSelected(null);
    if (promoting) setPromoting(null);
  }

  const xy = (sq: number) => {
    const file = sq & 7;
    const rank = sq >> 3;
    return whiteBottom
      ? { x: file * cell, y: (7 - rank) * cell }
      : { x: (7 - file) * cell, y: rank * cell };
  };
  const squareAt = (x: number, y: number): number | null => {
    const col = Math.floor(x / cell);
    const row = Math.floor(y / cell);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return whiteBottom ? (7 - row) * 8 + col : row * 8 + (7 - col);
  };
  const targets = selected === null ? [] : plies.filter((m) => m.from === selected);
  const movable = new Set(plies.map((m) => m.from));

  const tryMove = (from: number, to: number): boolean => {
    const options = plies.filter((m) => m.from === from && m.to === to);
    if (options.length === 0) return false;
    if (options.some((m) => m.promotion)) setPromoting({ from, to });
    else onMove({ from, to });
    setSelected(null);
    return true;
  };
  const tap = (sq: number) => {
    if (selected !== null && tryMove(selected, sq)) return;
    setSelected(movable.has(sq) && sq !== selected ? sq : null);
  };

  // Drag a piece; a touch that barely moves is a tap.
  const latest = useRef({ tap, tryMove, squareAt, movable });
  latest.current = { tap, tryMove, squareAt, movable };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          const from = latest.current.squareAt(locationX, locationY);
          if (from !== null && latest.current.movable.has(from)) {
            setDrag({ from, x: locationX, y: locationY });
          }
        },
        onPanResponderMove: (event, gesture) => {
          if (Math.hypot(gesture.dx, gesture.dy) < 8) return;
          const { locationX, locationY } = event.nativeEvent;
          setDrag((d) => (d ? { ...d, x: locationX, y: locationY } : d));
        },
        onPanResponderRelease: (event, gesture) => {
          const start = latest.current.squareAt(
            event.nativeEvent.locationX - gesture.dx,
            event.nativeEvent.locationY - gesture.dy,
          );
          setDrag(null);
          if (Math.hypot(gesture.dx, gesture.dy) < 8) {
            if (start !== null) latest.current.tap(start);
            return;
          }
          const end = latest.current.squareAt(
            event.nativeEvent.locationX,
            event.nativeEvent.locationY,
          );
          if (start !== null && end !== null && !latest.current.tryMove(start, end))
            setSelected(null);
        },
        onPanResponderTerminate: () => setDrag(null),
      }),
    [],
  );

  const checked =
    !state.ranks && position.inCheck() ? position.kings[position.side === 1 ? 0 : 1] : -1;
  const checkSquare = checked >= 0 ? (checked >> 4) * 8 + (checked & 7) : -1;
  const lastMove = state.lastMove;
  const sliding = last?.kind === 'move' && lastMove && moves ? lastMove : null;
  const piece = size / 8;

  return (
    <View
      accessibilityLabel={`Chess board, ${whiteBottom ? 'White' : 'Black'} at the bottom`}
      style={{ width: size, height: size, borderRadius: 10, overflow: 'hidden' }}
      {...(screenReader ? {} : responder.panHandlers)}
    >
      {Array.from({ length: 64 }, (_, sq) => {
        const { x, y } = xy(sq);
        const light = ((sq >> 3) + (sq & 7)) % 2 === 1;
        const tint =
          sq === checkSquare
            ? colors.check
            : sq === selected
              ? colors.selected
              : lastMove && (sq === lastMove.from || sq === lastMove.to)
                ? colors.lastMove
                : null;
        const row = whiteBottom ? 7 - (sq >> 3) : sq >> 3;
        const col = whiteBottom ? sq & 7 : 7 - (sq & 7);
        return (
          <View
            key={sq}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: cell,
              height: cell,
              backgroundColor: light ? colors.light : colors.dark,
            }}
          >
            {tint && <View style={{ position: 'absolute', inset: 0, backgroundColor: tint }} />}
            {col === 0 && (
              <Text
                style={{
                  position: 'absolute',
                  left: 2,
                  top: 1,
                  fontSize: cell * 0.2,
                  color: colors.coord,
                }}
              >
                {squareName(sq)[1]}
              </Text>
            )}
            {row === 7 && (
              <Text
                style={{
                  position: 'absolute',
                  right: 3,
                  bottom: 0,
                  fontSize: cell * 0.2,
                  color: colors.coord,
                }}
              >
                {squareName(sq)[0]}
              </Text>
            )}
          </View>
        );
      })}
      {Array.from({ length: 64 }, (_, sq) => {
        const value = position.pieceAt(sq);
        if (value === 0 || drag?.from === sq) return null;
        const { x, y } = xy(sq);
        const slide = sliding && sliding.to === sq ? xy(sliding.from) : null;
        return (
          <Animated.View
            key={`${sq}-${slide ? last?.id : 'still'}`}
            pointerEvents="none"
            style={[
              { position: 'absolute', left: x, top: y, width: cell, height: cell },
              slide
                ? {
                    animationName: {
                      from: {
                        transform: [{ translateX: slide.x - x }, { translateY: slide.y - y }],
                      },
                      to: { transform: [{ translateX: 0 }, { translateY: 0 }] },
                    },
                    animationDuration: pace.step + 60,
                    animationTimingFunction: CSS_EASE_OUT,
                  }
                : {},
            ]}
          >
            <ChessPiece piece={value} size={piece} colors={colors} />
          </Animated.View>
        );
      })}
      {targets.map((m) => {
        const { x, y } = xy(m.to);
        const capture = position.pieceAt(m.to) !== 0;
        return (
          <View
            key={`t${m.to}${m.promotion ?? ''}`}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: cell,
              height: cell,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={
                capture
                  ? {
                      width: cell * 0.92,
                      height: cell * 0.92,
                      borderRadius: cell,
                      borderWidth: cell * 0.09,
                      borderColor: colors.hint,
                    }
                  : {
                      width: cell * 0.3,
                      height: cell * 0.3,
                      borderRadius: cell,
                      backgroundColor: colors.hint,
                    }
              }
            />
          </View>
        );
      })}
      {drag && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: drag.x - cell * 0.6,
            top: drag.y - cell * 0.9,
            width: cell * 1.2,
            height: cell * 1.2,
          }}
        >
          <ChessPiece piece={position.pieceAt(drag.from)} size={cell * 1.2} colors={colors} />
        </View>
      )}
      {/* Squares for screen readers: the user's movable pieces and, once one is picked, its targets. */}
      {screenReader &&
        Array.from({ length: 64 }, (_, sq) => {
          const isTarget = targets.some((m) => m.to === sq);
          if (!movable.has(sq) && !isTarget) return null;
          const { x, y } = xy(sq);
          const value = position.pieceAt(sq);
          const label = `${squareName(sq)}${value ? `, ${value > 0 ? 'white' : 'black'} ${PIECE_NAMES[Math.abs(value)]}` : ''}`;
          return (
            <Tap
              key={`a${sq}`}
              accessibilityRole="button"
              accessibilityLabel={isTarget ? `Move to ${label}` : `${label}. Pick it up`}
              onPress={() => tap(sq)}
              style={{ position: 'absolute', left: x, top: y, width: cell, height: cell }}
            />
          );
        })}
      {promoting && (
        <View
          className="absolute inset-0 items-center justify-center"
          style={{ backgroundColor: 'rgba(5, 5, 15, 0.45)' }}
        >
          <View accessibilityViewIsModal className="flex-row gap-2 rounded-2xl bg-surface p-3">
            {PROMOTIONS.map((type) => (
              <Tap
                key={type}
                accessibilityRole="button"
                accessibilityLabel={`Promote to a ${PIECE_NAMES[type]}`}
                feedback="selection"
                onPress={() => {
                  onMove({ ...promoting, promotion: type });
                  setPromoting(null);
                }}
                className="items-center justify-center rounded-xl bg-raised"
                style={{ width: cell * 1.3, height: cell * 1.3 }}
              >
                <ChessPiece
                  piece={(position.side === 1 ? 1 : -1) * type}
                  size={cell * 1.1}
                  colors={colors}
                />
              </Tap>
            ))}
          </View>
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={() => setPromoting(null)}
            className="mt-3 px-4 py-2"
          >
            <Text className="font-bold text-on-primary">Cancel</Text>
          </Tap>
        </View>
      )}
    </View>
  );
}
