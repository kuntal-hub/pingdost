// Chess in the browser (Phase 44): the board turned so the user's side is at the bottom; click a
// piece then a square, or drag it (pointer events); Tab reaches the movable pieces and, once one
// is picked, its squares. Dots for moves, rings for captures, the last move and a king in check
// tinted, a picker when a pawn promotes, and the moved piece sliding in (`pd-slide`).
import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

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

import type { TurnBoardProps } from './boards';

type Ply = { from: number; to: number; promotion?: number };
const CELL = 100;
const PROMOTIONS = [QUEEN, ROOK, BISHOP, KNIGHT];

/** One piece drawn at (x, y) in board units, `size` wide. */
export function ChessPieceArt({
  piece,
  colors,
  x = 0,
  y = 0,
  size = CELL,
}: {
  piece: number;
  colors: ChessColors;
  x?: number;
  y?: number;
  size?: number;
}) {
  const look = piece > 0 ? colors.white : colors.black;
  const scale = size / PIECE_BOX;
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      {PIECE_SHAPES[Math.abs(piece)]!.map((shape, i) =>
        shape.kind === 'fill' ? (
          <path
            key={i}
            d={shape.d}
            fill={look.fill}
            stroke={look.edge}
            strokeWidth={PIECE_EDGE_WIDTH}
            strokeLinejoin="round"
          />
        ) : shape.kind === 'dot' ? (
          <path key={i} d={shape.d} fill={look.detail} />
        ) : (
          <path
            key={i}
            d={shape.d}
            fill="none"
            stroke={look.detail}
            strokeWidth={PIECE_LINE_WIDTH}
            strokeLinecap="round"
          />
        ),
      )}
    </g>
  );
}

/** A small piece icon for strips and buttons. */
export function ChessPieceIcon({
  piece,
  colors,
  size,
}: {
  piece: number;
  colors: ChessColors;
  size: number;
}) {
  return (
    <svg aria-hidden width={size} height={size} viewBox={`0 0 ${CELL} ${CELL}`}>
      <ChessPieceArt piece={piece} colors={colors} />
    </svg>
  );
}

export function ChessBoard({
  state,
  you,
  legal,
  last,
  onMove,
  dark,
  animate,
  pace,
}: TurnBoardProps<ChessState, ChessMove>) {
  const colors = gameBoardColors(dark).chess;
  const whiteBottom = you < 0 || chessSideOf(state, you) === 'white';
  const position = useMemo(() => chessPosition(state), [state.fen]);
  const plies = legal.filter((m): m is Ply => !('acceptDraw' in m));
  const [selected, setSelected] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number; moved: boolean } | null>(
    null,
  );
  const svg = useRef<SVGSVGElement | null>(null);
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
      ? { x: file * CELL, y: (7 - rank) * CELL }
      : { x: (7 - file) * CELL, y: rank * CELL };
  };
  const squareAt = (x: number, y: number): number | null => {
    const col = Math.floor(x / CELL);
    const row = Math.floor(y / CELL);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return whiteBottom ? (7 - row) * 8 + col : row * 8 + (7 - col);
  };
  const toBoard = (event: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return { x: -1, y: -1 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };
  const movable = new Set(plies.map((m) => m.from));
  const targets = selected === null ? [] : plies.filter((m) => m.from === selected);

  const tryMove = (from: number, to: number): boolean => {
    const options = plies.filter((m) => m.from === from && m.to === to);
    if (options.length === 0) return false;
    if (options.some((m) => m.promotion)) setPromoting({ from, to });
    else onMove({ from, to });
    setSelected(null);
    return true;
  };
  const pick = (sq: number) => {
    if (selected !== null && tryMove(selected, sq)) return;
    setSelected(movable.has(sq) && sq !== selected ? sq : null);
  };

  const checked =
    !state.ranks && position.inCheck() ? position.kings[position.side === 1 ? 0 : 1] : -1;
  const checkSquare = checked >= 0 ? (checked >> 4) * 8 + (checked & 7) : -1;
  const lastMove = state.lastMove;
  const sliding = last?.kind === 'move' && lastMove && animate ? lastMove : null;

  return (
    <div className="relative">
      <svg
        ref={svg}
        viewBox="0 0 800 800"
        className="w-full touch-none select-none rounded-xl"
        role="group"
        aria-label={`Chess board, ${whiteBottom ? 'White' : 'Black'} at the bottom`}
        onPointerDown={(event) => {
          const { x, y } = toBoard(event);
          const sq = squareAt(x, y);
          if (sq !== null && movable.has(sq)) {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ from: sq, x, y, moved: false });
          } else if (sq !== null) {
            // A square for the picked piece, or anywhere else to put it down.
            pick(sq);
          }
        }}
        onPointerMove={(event) => {
          if (!drag) return;
          const { x, y } = toBoard(event);
          const moved = drag.moved || Math.hypot(x - drag.x, y - drag.y) > 12;
          setDrag({ ...drag, x, y, moved });
        }}
        onPointerUp={(event) => {
          if (!drag) return;
          const { x, y } = toBoard(event);
          const end = squareAt(x, y);
          const was = drag;
          setDrag(null);
          if (was.moved && end !== null && !tryMove(was.from, end)) setSelected(null);
          if (!was.moved) pick(was.from);
        }}
        onPointerCancel={() => setDrag(null)}
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
            <g key={sq} aria-hidden>
              <rect
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                fill={light ? colors.light : colors.dark}
              />
              {tint && <rect x={x} y={y} width={CELL} height={CELL} fill={tint} />}
              {col === 0 && (
                <text x={x + 5} y={y + 22} fontSize={19} fill={colors.coord}>
                  {squareName(sq)[1]}
                </text>
              )}
              {row === 7 && (
                <text x={x + CELL - 16} y={y + CELL - 6} fontSize={19} fill={colors.coord}>
                  {squareName(sq)[0]}
                </text>
              )}
            </g>
          );
        })}
        {Array.from({ length: 64 }, (_, sq) => {
          const value = position.pieceAt(sq);
          if (value === 0 || (drag?.moved && drag.from === sq)) return null;
          const { x, y } = xy(sq);
          const from = sliding && sliding.to === sq ? xy(sliding.from) : null;
          return (
            <g
              key={`${sq}-${from ? last?.id : 'still'}`}
              transform={`translate(${x} ${y})`}
              aria-hidden
            >
              <g
                className={from ? 'pd-slide' : undefined}
                style={
                  from
                    ? ({
                        '--pd-dx': `${from.x - x}px`,
                        '--pd-dy': `${from.y - y}px`,
                        animationDuration: `${pace.step + 60}ms`,
                      } as CSSProperties)
                    : undefined
                }
              >
                <ChessPieceArt piece={value} colors={colors} />
              </g>
            </g>
          );
        })}
        {targets.map((m) => {
          const { x, y } = xy(m.to);
          return position.pieceAt(m.to) !== 0 ? (
            <circle
              key={`t${m.to}${m.promotion ?? ''}`}
              cx={x + 50}
              cy={y + 50}
              r={44}
              fill="none"
              stroke={colors.hint}
              strokeWidth={8}
              aria-hidden
            />
          ) : (
            <circle
              key={`t${m.to}${m.promotion ?? ''}`}
              cx={x + 50}
              cy={y + 50}
              r={15}
              fill={colors.hint}
              aria-hidden
            />
          );
        })}
        {drag?.moved && (
          <g pointerEvents="none">
            <ChessPieceArt
              piece={position.pieceAt(drag.from)}
              colors={colors}
              x={drag.x - 60}
              y={drag.y - 90}
              size={120}
            />
          </g>
        )}
        {Array.from({ length: 64 }, (_, sq) => {
          const isTarget = targets.some((m) => m.to === sq);
          if (!movable.has(sq) && !isTarget) return null;
          const { x, y } = xy(sq);
          const value = position.pieceAt(sq);
          const label = `${squareName(sq)}${value ? `, ${value > 0 ? 'white' : 'black'} ${PIECE_NAMES[Math.abs(value)]}` : ''}`;
          return (
            <rect
              key={`k${sq}`}
              x={x}
              y={y}
              width={CELL}
              height={CELL}
              fill="transparent"
              role="button"
              tabIndex={0}
              aria-label={isTarget ? `Move to ${label}` : `${label}. Pick it up`}
              className="pd-chess-focus cursor-pointer"
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  pick(sq);
                }
              }}
            />
          );
        })}
      </svg>
      {promoting && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-black/45">
          <div
            role="dialog"
            aria-label="Promote the pawn"
            className="pd-pop flex gap-2 rounded-2xl bg-surface p-3"
          >
            {PROMOTIONS.map((type) => (
              <button
                key={type}
                type="button"
                aria-label={`Promote to a ${PIECE_NAMES[type]}`}
                onClick={() => {
                  onMove({ ...promoting, promotion: type });
                  setPromoting(null);
                }}
                className="pd-press cursor-pointer rounded-xl bg-raised p-1 hover:bg-surface"
              >
                <ChessPieceIcon
                  piece={(position.side === 1 ? 1 : -1) * type}
                  colors={colors}
                  size={56}
                />
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPromoting(null)}
            className="cursor-pointer font-bold text-white"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
