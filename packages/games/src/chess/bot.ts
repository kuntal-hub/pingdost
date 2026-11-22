// The chess computer player (Phase 44): iterative deepening alpha-beta with a capture search at
// the leaves, a small evaluation (material, piece placement worked out by formula, bishop pair,
// king safety then activity), and a time budget. The search yields between root moves, so the
// app keeps drawing and taking taps while it thinks. Easy looks one move ahead and picks among
// moves close to the best (sometimes any move); Medium searches about three plies; Hard as deep as
// its budget allows. No engine binary, no tables copied from anywhere.
import {
  BISHOP,
  from88,
  KING,
  KNIGHT,
  moveFrom,
  movePromotion,
  moveTo,
  PAWN,
  Position,
  QUEEN,
  ROOK,
  type Move,
} from './position';
import type { ChessMove, ChessState } from './rules';
import type { Random } from '../core/random';
import type { BotLevel } from '../core/types';

const VALUE = [0, 100, 320, 330, 500, 900, 0];
const MATE = 100_000;

class Abort extends Error {}

/** Centralness 0 (edge) to 3 (the four middle squares) of a 0x88 square. */
function central(sq: number): number {
  const file = sq & 7;
  const rank = sq >> 4;
  return Math.min(file, 7 - file, rank, 7 - rank);
}

/** The position from the side to move's point of view, in centipawns. */
export function evaluateChess(p: Position): number {
  const b = p.board;
  let score = 0;
  let material = 0;
  const bishops = [0, 0];
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const type = Math.abs(b[sq]!);
    if (type !== 0 && type !== PAWN && type !== KING) material += VALUE[type]!;
  }
  // The endgame: few pieces left, kings come out.
  const endgame = material <= 2600;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const piece = b[sq]!;
    if (piece === 0) continue;
    const side = Math.sign(piece);
    const type = Math.abs(piece);
    const rank = side === 1 ? sq >> 4 : 7 - (sq >> 4);
    const c = central(sq);
    let v = VALUE[type]!;
    switch (type) {
      case PAWN: {
        v += rank * (endgame ? 12 : 6);
        const file = sq & 7;
        if ((file === 3 || file === 4) && rank >= 3) v += 12;
        break;
      }
      case KNIGHT:
        v += c * 10 - 15;
        break;
      case BISHOP:
        v += c * 5;
        bishops[side === 1 ? 0 : 1]! += 1;
        break;
      case ROOK:
        if (rank === 6) v += 15;
        break;
      case QUEEN:
        v += c * 2;
        break;
      case KING:
        v += endgame ? c * 12 : rank === 0 ? ((sq & 7) <= 2 || (sq & 7) >= 6 ? 25 : 5) : -20 * rank;
        break;
    }
    score += side * v;
  }
  if (bishops[0]! >= 2) score += 30;
  if (bishops[1]! >= 2) score -= 30;
  return score * p.side;
}

function captureOrder(p: Position, moves: Move[]): Move[] {
  const value = (m: Move) =>
    VALUE[Math.abs(p.board[moveTo(m)]!)]! * 10 -
    VALUE[Math.abs(p.board[moveFrom(m)]!)]! / 10 +
    (movePromotion(m) ? 800 : 0);
  return moves.sort((a, c) => value(c) - value(a));
}

interface Search {
  p: Position;
  deadline: number;
  nodes: number;
  killers: Move[][];
}

function tick(s: Search): void {
  if (++s.nodes % 2048 === 0 && Date.now() > s.deadline) throw new Abort();
}

function quiesce(s: Search, alpha: number, beta: number, ply: number): number {
  tick(s);
  const standPat = evaluateChess(s.p);
  if (standPat >= beta) return standPat;
  if (standPat > alpha) alpha = standPat;
  if (ply > 12) return standPat;
  for (const m of captureOrder(s.p, s.p.pseudoMoves(true))) {
    if (!s.p.make(m)) continue;
    const score = -quiesce(s, -beta, -alpha, ply + 1);
    s.p.unmake();
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function order(s: Search, moves: Move[], ply: number, first?: Move): Move[] {
  const killers = s.killers[ply] ?? [];
  const value = (m: Move) => {
    if (m === first) return 1e9;
    const victim = s.p.board[moveTo(m)]!;
    if (victim !== 0 || movePromotion(m)) {
      return 1e6 + VALUE[Math.abs(victim)]! * 10 - VALUE[Math.abs(s.p.board[moveFrom(m)]!)]! / 10;
    }
    return killers.includes(m) ? 1e5 : 0;
  };
  return moves.sort((a, b) => value(b) - value(a));
}

function negamax(s: Search, depth: number, alpha: number, beta: number, ply: number): number {
  if (depth <= 0) return quiesce(s, alpha, beta, ply);
  tick(s);
  if (s.p.halfmove >= 100) return 0;
  let legal = 0;
  let best = -Infinity;
  for (const m of order(s, s.p.pseudoMoves(), ply)) {
    if (!s.p.make(m)) continue;
    legal++;
    const score = -negamax(s, depth - 1, -beta, -alpha, ply + 1);
    s.p.unmake();
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      // A quiet move that refuted this line is tried early in sibling lines (two per ply).
      if (s.p.board[moveTo(m)] === 0) {
        const k = (s.killers[ply] ??= []);
        if (!k.includes(m)) {
          k.unshift(m);
          if (k.length > 2) k.length = 2;
        }
      }
      break;
    }
  }
  if (legal === 0) return s.p.inCheck() ? -MATE + ply : 0;
  return best;
}

export interface ChessSearchOptions {
  /** Think at most this long (ms). */
  budgetMs?: number;
  /** Plies at most. */
  maxDepth?: number;
  /** Let the event loop run between root moves (apps); off for tests. */
  yieldToUi?: boolean;
  /** Root moves within this many centipawns of the best get exact scores. */
  slack?: number;
}

const LEVELS: Record<BotLevel, { depth: number; budgetMs: number; slack: number; wild: number }> = {
  easy: { depth: 1, budgetMs: 300, slack: 150, wild: 0.15 },
  medium: { depth: 3, budgetMs: 700, slack: 15, wild: 0 },
  hard: { depth: 6, budgetMs: 1_600, slack: 0, wild: 0 },
};

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Scores of every root move from the deepest search finished in time (best first). */
export async function searchChess(
  p: Position,
  options: ChessSearchOptions,
): Promise<{ move: Move; score: number }[]> {
  const moves = p.legalMoves();
  if (moves.length <= 1) return moves.map((move) => ({ move, score: 0 }));
  const started = Date.now();
  const s: Search = {
    p,
    deadline: started + (options.budgetMs ?? 1_000),
    nodes: 0,
    killers: [],
  };
  let scored = moves.map((move) => ({ move, score: 0 }));
  let lastYield = Date.now();
  const root = p.depth;
  const slack = options.slack ?? 0;
  for (let depth = 1; depth <= (options.maxDepth ?? 6); depth++) {
    const round: { move: Move; score: number }[] = [];
    let best = -Infinity;
    try {
      for (const { move } of scored) {
        if (options.yieldToUi && Date.now() - lastYield > 12) {
          await nextTick();
          lastYield = Date.now();
        }
        p.make(move);
        // Moves that can't come within `slack` of the best so far only need a bound.
        const floor = best === -Infinity ? -Infinity : best - slack - 1;
        const score = -negamax(s, depth - 1, -Infinity, -floor, 1);
        p.unmake();
        round.push({ move, score });
        if (score > best) best = score;
      }
    } catch (error) {
      if (!(error instanceof Abort)) throw error;
      // Out of time: back to the root, and keep the last finished depth.
      while (p.depth > root) p.unmake();
      break;
    }
    scored = round.sort((a, b) => b.score - a.score);
    if (scored[0]!.score >= MATE - 100) break;
    if (Date.now() > s.deadline) break;
  }
  return scored;
}

export async function chooseChessMove(
  state: ChessState,
  level: BotLevel,
  random: Random,
  options: ChessSearchOptions = {},
): Promise<ChessMove> {
  const p = Position.fromFen(state.fen);
  const config = LEVELS[level];
  const moves = p.legalMoves();
  if (moves.length === 0) throw new Error('no legal moves');
  const pick = (m: Move) => {
    const promotion = movePromotion(m);
    return {
      from: from88(moveFrom(m)),
      to: from88(moveTo(m)),
      ...(promotion ? { promotion } : {}),
    };
  };
  if (config.wild > 0 && random.next() < config.wild) return pick(moves[random.int(moves.length)]!);
  const scored = await searchChess(p, {
    budgetMs: options.budgetMs ?? config.budgetMs,
    maxDepth: options.maxDepth ?? config.depth,
    yieldToUi: options.yieldToUi ?? true,
    slack: config.slack,
  });
  const best = scored[0]!.score;
  const close = scored.filter((s) => s.score >= best - config.slack);
  return pick(close[random.int(close.length)]!.move);
}
