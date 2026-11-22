// The quick games' boards in the browser (Phase 43): SVG drawn from the game state, colors from
// ui-tokens, motion through `pd-*` classes (Calm and Off in styles.css) and, for the Snakes and
// Ladders walk, the Web Animations API. Every move target is a focusable button.
import {
  memo,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
} from 'react';

import {
  C4_COLUMNS,
  C4_ROWS,
  connectFourColor,
  DOTS_COLOR_NAMES,
  DOTS_COLORS,
  dotsLineAt,
  LADDERS,
  SNAKES,
  SNAKES_COLOR_NAMES,
  SNAKES_COLORS,
  snakesPath,
  snakesSquareAt,
  ticTacToeMark,
  type AnyTurnRules,
  type ConnectFourMove,
  type ConnectFourState,
  type DotsMove,
  type DotsState,
  type SnakesState,
  type TicTacToeMove,
  type TicTacToeState,
  type TurnCore,
  type TurnLast,
  type TurnPace,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { CallBridgeBoard } from './call-bridge-board';
import { ChessBoard } from './chess-board';
import { LastCardBoard } from './last-card-board';
import { ShapeGlyph } from '../shape';

export interface TurnBoardProps<S extends TurnCore = TurnCore, M = unknown> {
  state: S;
  you: number;
  legal: readonly M[];
  last: TurnLast<S, M> | null;
  onMove: (move: M) => void;
  dark: boolean;
  animate: boolean;
  pace: TurnPace;
}

/** Enter or Space on a focusable SVG target. */
function pressKeys(run: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      run();
    }
  };
}

const ROWS = ['top', 'middle', 'bottom'];
const COLS = ['left', 'centre', 'right'];

export function TicTacToeBoard({
  state,
  legal,
  last,
  onMove,
  dark,
  pace,
}: TurnBoardProps<TicTacToeState, TicTacToeMove>) {
  const colors = gameBoardColors(dark);
  const open = new Set(legal.map((m) => m.cell));
  const color = (seat: number) =>
    ticTacToeMark(state, seat) === 'X' ? colors.players.red.fill : colors.players.blue.fill;
  const mid = (i: number) => ({ x: (i % 3) * 100 + 50, y: Math.floor(i / 3) * 100 + 50 });
  return (
    <svg
      viewBox="0 0 300 300"
      className="w-full"
      role="group"
      aria-label="Tic-Tac-Toe board (keys 1–9)"
    >
      <rect width={300} height={300} rx={22} fill={colors.cell} />
      {[100, 200].map((k) => (
        <g key={k} stroke={colors.line} strokeWidth={4} strokeLinecap="round">
          <line x1={k} y1={12} x2={k} y2={288} />
          <line x1={12} y1={k} x2={288} y2={k} />
        </g>
      ))}
      {state.cells.map((owner, i) => {
        const { x, y } = mid(i);
        const label = `${ROWS[Math.floor(i / 3)]} ${COLS[i % 3]}`;
        if (owner < 0) {
          if (!open.has(i)) return null;
          return (
            <g
              key={i}
              role="button"
              tabIndex={0}
              aria-label={`${label}, empty. Play here`}
              className="pd-piece-target cursor-pointer"
              onClick={() => onMove({ cell: i })}
              onKeyDown={pressKeys(() => onMove({ cell: i }))}
            >
              <rect x={x - 50} y={y - 50} width={100} height={100} fill="transparent" />
              <rect
                x={x - 42}
                y={y - 42}
                width={84}
                height={84}
                rx={14}
                fill="none"
                stroke={colors.line}
                strokeWidth={3}
                className="pd-piece-focus"
              />
            </g>
          );
        }
        const fresh = last?.move?.cell === i;
        const mark = ticTacToeMark(state, owner);
        return (
          <g
            key={`${i}-${fresh ? last?.id : 'old'}`}
            aria-label={`${label}, ${mark}`}
            role="img"
            className={fresh ? 'pd-mark-in' : undefined}
            style={fresh ? { animationDuration: `${pace.step}ms` } : undefined}
            stroke={color(owner)}
            strokeWidth={11}
            strokeLinecap="round"
            fill="none"
          >
            {mark === 'X' ? (
              <>
                <line x1={x - 28} y1={y - 28} x2={x + 28} y2={y + 28} />
                <line x1={x + 28} y1={y - 28} x2={x - 28} y2={y + 28} />
              </>
            ) : (
              <circle cx={x} cy={y} r={29} />
            )}
          </g>
        );
      })}
      {state.line && (
        <line
          x1={mid(state.line[0]!).x}
          y1={mid(state.line[0]!).y}
          x2={mid(state.line[2]!).x}
          y2={mid(state.line[2]!).y}
          stroke={color(state.cells[state.line[0]!]!)}
          strokeOpacity={0.55}
          strokeWidth={16}
          strokeLinecap="round"
          pathLength={1}
          className="pd-draw-line"
        />
      )}
    </svg>
  );
}

export function ConnectFourBoard({
  state,
  legal,
  last,
  onMove,
  dark,
  pace,
}: TurnBoardProps<ConnectFourState, ConnectFourMove>) {
  const colors = gameBoardColors(dark);
  const cell = 100;
  const pad = 20;
  const width = C4_COLUMNS * cell + pad * 2;
  const height = C4_ROWS * cell + pad * 2;
  const open = new Set(legal.map((m) => m.column));
  const winning = new Set(state.line ?? []);
  const lastIndex =
    last?.move !== undefined
      ? state.cells.findIndex((v, i) => i % C4_COLUMNS === last.move!.column && v >= 0)
      : -1;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="group"
      aria-label="Connect Four board (keys 1–7)"
    >
      <rect width={width} height={height} rx={26} fill={colors.frame} />
      {state.cells.map((owner, i) => {
        const row = Math.floor(i / C4_COLUMNS);
        const col = i % C4_COLUMNS;
        const cx = pad + col * cell + cell / 2;
        const cy = pad + row * cell + cell / 2;
        const look = owner >= 0 ? colors.players[connectFourColor(state, owner)] : null;
        const fresh = i === lastIndex;
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={41} fill={colors.board} />
            {look && (
              <g
                key={fresh ? `drop${last?.id}` : 'still'}
                className={fresh ? 'pd-drop' : undefined}
                style={
                  fresh
                    ? ({
                        '--pd-drop': `${-(cy + cell)}px`,
                        animationDuration: `${Math.max(180, pace.step + row * (pace.hop / 3))}ms`,
                      } as CSSProperties)
                    : undefined
                }
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={39}
                  fill={look.fill}
                  stroke={winning.has(i) ? colors.cell : look.ring}
                  strokeWidth={winning.has(i) ? 8 : 4}
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={24}
                  fill="none"
                  stroke={look.dark}
                  strokeOpacity={0.35}
                  strokeWidth={4}
                />
                <circle cx={cx - 12} cy={cy - 14} r={9} fill={look.light} opacity={0.55} />
              </g>
            )}
          </g>
        );
      })}
      {Array.from({ length: C4_COLUMNS }, (_, col) =>
        open.has(col) ? (
          <g
            key={col}
            role="button"
            tabIndex={0}
            aria-label={`Column ${col + 1}. Drop a disc`}
            className="pd-piece-target cursor-pointer"
            onClick={() => onMove({ column: col })}
            onKeyDown={pressKeys(() => onMove({ column: col }))}
          >
            <rect x={pad + col * cell} y={0} width={cell} height={height} fill="transparent" />
            <rect
              x={pad + col * cell + 6}
              y={8}
              width={cell - 12}
              height={height - 16}
              rx={20}
              fill="none"
              stroke={colors.cell}
              strokeWidth={4}
              className="pd-piece-focus"
            />
          </g>
        ) : null,
      )}
    </svg>
  );
}

export function DotsBoard({
  state,
  legal,
  last,
  onMove,
  dark,
  pace,
}: TurnBoardProps<DotsState, DotsMove>) {
  const colors = gameBoardColors(dark);
  const n = state.settings.size;
  const gap = 100;
  const pad = 30;
  const size = n * gap + pad * 2;
  const open = new Set(legal.map((m) => m.line));
  const before = last?.before;
  const ends = (line: number) => {
    const at = dotsLineAt(n, line);
    const x1 = pad + at.col * gap;
    const y1 = pad + at.row * gap;
    return at.horizontal ? { x1, y1, x2: x1 + gap, y2: y1 } : { x1, y1, x2: x1, y2: y1 + gap };
  };
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="w-full"
      role="group"
      aria-label="Dots and Boxes board"
    >
      <rect width={size} height={size} rx={26} fill={colors.board} />
      {state.boxes.map((owner, box) => {
        if (owner < 0) return null;
        const color = DOTS_COLORS[owner] ?? 'red';
        const look = colors.players[color];
        const x = pad + (box % n) * gap;
        const y = pad + Math.floor(box / n) * gap;
        const fresh = before ? before.boxes[box] === -1 : false;
        return (
          <g
            key={`${box}-${fresh ? last?.id : 'old'}`}
            role="img"
            aria-label={`Box closed by ${DOTS_COLOR_NAMES[owner]}`}
            className={fresh ? 'pd-mark-in' : undefined}
            style={fresh ? { animationDuration: `${pace.step + 120}ms` } : undefined}
          >
            <rect x={x + 8} y={y + 8} width={gap - 16} height={gap - 16} rx={8} fill={look.soft} />
            <g transform={`translate(${x + gap / 2} ${y + gap / 2})`}>
              <ShapeGlyph color={color} size={40} fill={look.fill} />
            </g>
          </g>
        );
      })}
      {state.lines.map((owner, line) => {
        const e = ends(line);
        if (owner >= 0) {
          const look = colors.players[DOTS_COLORS[owner] ?? 'red'];
          const fresh = last?.move?.line === line;
          return (
            <line
              key={`${line}-${fresh ? last?.id : 'old'}`}
              {...e}
              pathLength={1}
              stroke={look.fill}
              strokeWidth={11}
              strokeLinecap="round"
              className={fresh ? 'pd-draw-line' : undefined}
              style={fresh ? { animationDuration: `${pace.step}ms` } : undefined}
            />
          );
        }
        if (!open.has(line)) return null;
        const at = dotsLineAt(n, line);
        return (
          <g
            key={line}
            role="button"
            tabIndex={0}
            aria-label={`${at.horizontal ? 'Line across' : 'Line down'}, row ${at.row + 1}, column ${at.col + 1}`}
            className="pd-piece-target cursor-pointer"
            onClick={() => onMove({ line })}
            onKeyDown={pressKeys(() => onMove({ line }))}
          >
            <line {...e} stroke="transparent" strokeWidth={36} />
            <line
              {...e}
              stroke={colors.dot}
              strokeOpacity={0.3}
              strokeWidth={5}
              strokeDasharray="10 10"
              strokeLinecap="round"
            />
            <line
              {...e}
              stroke={colors.dot}
              strokeWidth={9}
              strokeLinecap="round"
              className="pd-piece-focus"
            />
          </g>
        );
      })}
      {Array.from({ length: (n + 1) * (n + 1) }, (_, i) => (
        <circle
          key={i}
          cx={pad + (i % (n + 1)) * gap}
          cy={pad + Math.floor(i / (n + 1)) * gap}
          r={9}
          fill={colors.dot}
        />
      ))}
    </svg>
  );
}

const CELL = 100;

function center(square: number) {
  const { row, col } = snakesSquareAt(square);
  return { x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 };
}

/** The board itself, drawn again only when the theme changes. */
const SnakesBoardArt = memo(function SnakesBoardArt({ dark }: { dark: boolean }) {
  const colors = gameBoardColors(dark);
  return (
    <g aria-hidden>
      {Array.from({ length: 100 }, (_, i) => {
        const square = i + 1;
        const { row, col } = snakesSquareAt(square);
        return (
          <g key={square}>
            <rect
              x={col * CELL}
              y={row * CELL}
              width={CELL}
              height={CELL}
              fill={(row + col) % 2 === 0 ? colors.cell : colors.cellAlt}
            />
            <text x={col * CELL + 6} y={row * CELL + 26} fontSize={22} fill={colors.label}>
              {square}
            </text>
          </g>
        );
      })}
      {LADDERS.map(([from, to]) => {
        const a = center(from);
        const b = center(to);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        const px = (-dy / length) * 17;
        const py = (dx / length) * 17;
        const rungs = Math.max(2, Math.floor(length / 45));
        return (
          <g key={`l${from}`} stroke={colors.ladder} strokeLinecap="round">
            {[-1, 1].map((side) => (
              <line
                key={side}
                x1={a.x + px * side}
                y1={a.y + py * side}
                x2={b.x + px * side}
                y2={b.y + py * side}
                strokeWidth={8}
              />
            ))}
            {Array.from({ length: rungs }, (_, k) => {
              const t = (k + 0.5) / rungs;
              const x = a.x + dx * t;
              const y = a.y + dy * t;
              return (
                <line key={k} x1={x - px} y1={y - py} x2={x + px} y2={y + py} strokeWidth={6} />
              );
            })}
          </g>
        );
      })}
      {SNAKES.map(([head, tail], k) => {
        const a = center(head);
        const b = center(tail);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        const wave = Math.min(90, length * 0.22);
        const px = (-dy / length) * wave;
        const py = (dx / length) * wave;
        const d = `M ${a.x} ${a.y} C ${a.x + dx / 3 + px} ${a.y + dy / 3 + py}, ${a.x + (2 * dx) / 3 - px} ${a.y + (2 * dy) / 3 - py}, ${b.x} ${b.y}`;
        const color = colors.snakes[k % colors.snakes.length]!;
        const ex = (dx / length) * 8;
        const ey = (dy / length) * 8;
        return (
          <g key={`s${head}`}>
            <path d={d} stroke={color} strokeWidth={26} strokeLinecap="round" fill="none" />
            <path
              d={d}
              stroke={colors.cell}
              strokeOpacity={0.45}
              strokeWidth={6}
              strokeDasharray="12 18"
              fill="none"
            />
            <circle cx={a.x} cy={a.y} r={22} fill={color} />
            {[-1, 1].map((side) => (
              <circle
                key={side}
                cx={a.x - ex + (py / wave) * 9 * side}
                cy={a.y - ey - (px / wave) * 9 * side}
                r={5}
                fill={colors.cell}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
});

export function SnakesBoard({
  state,
  last,
  dark,
  animate,
  pace,
}: TurnBoardProps<SnakesState, never>) {
  const colors = gameBoardColors(dark);
  const strip = 110;
  const mover = last?.kind === 'roll' && last.die !== undefined ? last.seat : -1;
  const moverRef = useRef<SVGGElement | null>(null);
  const spot = (seat: number, square: number) => {
    if (square === 0) return { x: 100 + seat * 140, y: 1000 + strip / 2 };
    const sharing = state.positions.flatMap((p, s) => (p === square && !state.left[s] ? [s] : []));
    const c = center(square);
    if (sharing.length <= 1) return c;
    const k = sharing.indexOf(seat);
    return { x: c.x + (k % 2 === 0 ? -18 : 18), y: c.y + (k < 2 ? -16 : 16) };
  };
  const lastId = last?.id;
  useLayoutEffect(() => {
    const el = moverRef.current;
    if (!el || !animate || !last || mover < 0 || !last.before || typeof el.animate !== 'function')
      return;
    const before = last.before;
    const path = snakesPath(before.positions[mover]!, last.die!, before.settings);
    const points = [spot(mover, before.positions[mover]!), ...path.walk.map((s) => center(s))];
    if (path.jump) points.push(spot(mover, state.positions[mover]!));
    const total = path.walk.length * pace.hop + (path.jump ? pace.slide : 0);
    if (total <= 0 || points.length < 2) return;
    let at = 0;
    const frames = points.map((p, k) => {
      if (k > 0) at += k <= path.walk.length ? pace.hop : pace.slide;
      return { transform: `translate(${p.x}px, ${p.y}px)`, offset: at / total };
    });
    const run = el.animate(frames, { duration: total, easing: 'linear' });
    return () => run.cancel();
    // A new step (its id) starts the walk.
  }, [lastId]);
  return (
    <svg
      viewBox={`0 0 1000 ${1000 + strip}`}
      className="w-full"
      role="group"
      aria-label="Snakes and Ladders board"
    >
      <clipPath id="pd-snakes-clip">
        <rect width={1000} height={1000} rx={24} />
      </clipPath>
      <g clipPath="url(#pd-snakes-clip)">
        <SnakesBoardArt dark={dark} />
      </g>
      <text x={8} y={1000 + strip / 2 + 8} fontSize={24} fontWeight={700} fill={colors.label}>
        Start
      </text>
      {state.positions.map((square, seat) => {
        if (state.left[seat]) return null;
        const color = SNAKES_COLORS[seat] ?? 'red';
        const look = colors.players[color];
        const p = spot(seat, square);
        return (
          <g
            key={seat}
            ref={seat === mover ? moverRef : undefined}
            role="img"
            aria-label={`${SNAKES_COLOR_NAMES[seat]} on ${square === 0 ? 'the start' : `square ${square}`}`}
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
          >
            <circle r={30} fill={look.fill} stroke={look.ring} strokeWidth={5} />
            <ShapeGlyph color={color} size={28} fill={look.on} />
          </g>
        );
      })}
    </svg>
  );
}

const BOARDS = {
  'tic-tac-toe': TicTacToeBoard,
  'connect-four': ConnectFourBoard,
  'dots-and-boxes': DotsBoard,
  'snakes-and-ladders': SnakesBoard,
  chess: ChessBoard,
  'last-card': LastCardBoard,
  'call-bridge': CallBridgeBoard,
} as unknown as Record<AnyTurnRules['id'], (props: TurnBoardProps) => JSX.Element>;

export function TurnBoard({ rules, ...props }: TurnBoardProps & { rules: AnyTurnRules }) {
  const Board = BOARDS[rules.id];
  return <Board {...props} />;
}
