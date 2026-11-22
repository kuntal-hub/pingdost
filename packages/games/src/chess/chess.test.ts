import { describe, expect, it } from 'vitest';

import { chooseChessMove, evaluateChess, searchChess } from './bot';
import { parseSquare, Position, START_FEN } from './position';
import { CHESS, isPromotion, type ChessMove, type ChessState } from './rules';
import { seededRandom } from '../core/random';
import type { BotLevel } from '../core/types';

const sq = parseSquare;
/** Plays moves given as "e2e4" (or "e7e8q"). */
function play(state: ChessState, ...moves: string[]): ChessState {
  return moves.reduce((s, m) => {
    const promo = m[4] ? { n: 2, b: 3, r: 4, q: 5 }[m[4] as 'n' | 'b' | 'r' | 'q'] : undefined;
    const move: ChessMove = {
      from: sq(m.slice(0, 2)),
      to: sq(m.slice(2, 4)),
      ...(promo ? { promotion: promo } : {}),
    };
    const next = CHESS.apply(s, move);
    if (next === s) throw new Error(`illegal: ${m}`);
    return next;
  }, state);
}
const fresh = (white = 0) => CHESS.setup(2, CHESS.defaultSettings, white);
const at = (fen: string): ChessState => ({
  ...fresh(),
  fen,
  keys: [Position.fromFen(fen).fen(true)],
});

describe('chess move generator (perft)', () => {
  // Standard positions with published node counts.
  const cases: [string, string, number[]][] = [
    ['start', START_FEN, [20, 400, 8902, 197281]],
    [
      'kiwipete',
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      [48, 2039, 97862],
    ],
    ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    [
      'position 4',
      'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
      [6, 264, 9467],
    ],
    ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ];
  for (const [name, fen, counts] of cases) {
    it(`${name}`, () => {
      const p = Position.fromFen(fen);
      counts.forEach((count, i) => expect(p.perft(i + 1), `${name} depth ${i + 1}`).toBe(count));
      expect(p.fen()).toBe(Position.fromFen(fen).fen());
    });
  }
});

describe('chess rules', () => {
  it('reads and writes FEN', () => {
    expect(Position.fromFen(START_FEN).fen()).toBe(START_FEN);
    const after = play(fresh(), 'e2e4');
    expect(after.fen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(after.san).toEqual(['e4']);
    expect(after.current).toBe(1);
  });

  it('mates (fool’s mate), with SAN and the result', () => {
    const state = play(fresh(1), 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    expect(state.san).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    expect(state.end).toBe('checkmate');
    // White was seat 1, so Black (seat 0) won.
    expect(state.ranks).toEqual([1, 2]);
    expect(CHESS.resultDetail!(state)).toBe('Checkmate');
  });

  it('castles both ways, never through check', () => {
    const open = at('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const short = play(open, 'e1g1');
    expect(short.san).toEqual(['O-O']);
    expect(short.fen.startsWith('r3k2r/8/8/8/8/8/8/R4RK1 b kq')).toBe(true);
    expect(play(open, 'e1c1').san).toEqual(['O-O-O']);
    // A rook on f8 covers f1: no short castling.
    const covered = at('5r2/4k3/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(CHESS.isLegal(covered, { from: sq('e1'), to: sq('g1') })).toBe(false);
    expect(CHESS.isLegal(covered, { from: sq('e1'), to: sq('c1') })).toBe(true);
  });

  it('takes en passant and promotes', () => {
    const ep = play(at('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'), 'e5d6');
    expect(ep.san).toEqual(['exd6']);
    expect(Position.fromFen(ep.fen).pieceAt(sq('d5'))).toBe(0);
    const before = at('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    expect(isPromotion(before, sq('b7'), sq('b8'))).toBe(true);
    expect(CHESS.isLegal(before, { from: sq('b7'), to: sq('b8') })).toBe(false);
    const queen = play(before, 'b7b8q');
    expect(queen.san).toEqual(['b8=Q+']);
    expect(play(before, 'b7b8n').san).toEqual(['b8=N']);
  });

  it('tells like pieces apart in SAN', () => {
    const state = play(at('4k3/8/8/8/8/8/4K3/R6R w - - 0 1'), 'a1d1');
    expect(state.san).toEqual(['Rad1']);
  });

  it('draws by stalemate, insufficient material, the fifty-move rule and repetition', () => {
    const stale = play(at('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'), 'f7g7');
    expect(stale.end).toBe('checkmate');
    const stalemate = play(at('7k/8/5Q2/6K1/8/8/8/8 w - - 0 1'), 'f6f7');
    expect(stalemate.end).toBe('stalemate');
    expect(stalemate.ranks).toEqual([1, 1]);
    const bare = play(at('4k3/8/8/8/8/8/4q3/4K3 w - - 0 1'), 'e1e2');
    expect(bare.end).toBe('material');
    const fifty = play(at('4k3/8/8/8/8/8/8/R3K3 w - - 99 80'), 'a1a2');
    expect(fifty.end).toBe('fifty-moves');
    const repeat = play(fresh(), 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8');
    expect(repeat.end).toBe('repetition');
  });

  it('offers, accepts and resigns', () => {
    const offered = CHESS.apply(fresh(), { from: sq('e2'), to: sq('e4'), offerDraw: true });
    expect(offered.drawOffer).toBe(0);
    expect(CHESS.isLegal(offered, { acceptDraw: true })).toBe(true);
    const agreed = CHESS.apply(offered, { acceptDraw: true });
    expect(agreed.end).toBe('agreed');
    expect(agreed.ranks).toEqual([1, 1]);
    // Playing on declines the offer.
    const declined = play(offered, 'e7e5');
    expect(declined.drawOffer).toBeNull();
    expect(CHESS.isLegal(declined, { acceptDraw: true })).toBe(false);
    const resigned = CHESS.leave(fresh(), 0);
    expect(resigned.end).toBe('resigned');
    expect(resigned.ranks).toEqual([2, 1]);
  });

  it('round-trips wire moves, picks sides, restores saves', () => {
    const move: ChessMove = { from: sq('e7'), to: sq('e8'), promotion: 5, offerDraw: true };
    const wire = CHESS.moveToWire(move);
    expect(wire?.case).toBe('chess');
    expect(CHESS.firstSeat!({ hostSide: 'white' }, 1, 0, 2)).toBe(0);
    expect(CHESS.firstSeat!({ hostSide: 'black' }, 1, 0, 2)).toBe(1);
    expect(CHESS.firstSeat!({ hostSide: 'random' }, 1, 0, 2)).toBe(1);
    const state = play(fresh(), 'e2e4', 'c7c5');
    expect(CHESS.restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(CHESS.restore({ ...state, fen: 'nonsense' })).toBeNull();
  });
});

describe('chess computer player', () => {
  it('takes a free queen and finds mate in one', async () => {
    const free = at('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1');
    for (const level of ['medium', 'hard'] as BotLevel[]) {
      const move = (await chooseChessMove(free, level, seededRandom(1), {
        yieldToUi: false,
        budgetMs: 2_000,
      })) as {
        from: number;
        to: number;
      };
      expect([move.from, move.to]).toEqual([sq('e4'), sq('d5')]);
    }
    const mate = at('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    const move = (await chooseChessMove(mate, 'medium', seededRandom(2), { yieldToUi: false })) as {
      to: number;
    };
    expect(move.to).toBe(sq('d8'));
  });

  it('stops at its time budget and leaves the position as it found it', async () => {
    const p = Position.fromFen(
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    );
    const before = p.fen();
    const started = Date.now();
    const scored = await searchChess(p, { budgetMs: 150, maxDepth: 20 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(scored.length).toBe(48);
    expect(p.fen()).toBe(before);
    expect(evaluateChess(Position.fromFen(START_FEN))).toBe(0);
  });

  it('a deeper search beats a shallow one', async () => {
    // Short games from the start, adjudicated by material: depth 2 should not lose to depth 1.
    let deeper = 0;
    let shallower = 0;
    const random = seededRandom(3);
    for (let game = 0; game < 4; game++) {
      let state = CHESS.setup(2, CHESS.defaultSettings, game % 2);
      for (let ply = 0; ply < 40 && !state.ranks; ply++) {
        const deep = state.current === 0;
        const move = await chooseChessMove(state, deep ? 'medium' : 'easy', random, {
          yieldToUi: false,
          maxDepth: deep ? 2 : 1,
          budgetMs: 5_000,
        });
        state = CHESS.apply(state, move);
      }
      const p = Position.fromFen(state.fen);
      const material = evaluateChess(p) * p.side * (state.white === 0 ? 1 : -1);
      if (state.ranks?.[0] === 1 && state.ranks[1] === 2) deeper++;
      else if (state.ranks?.[1] === 1 && state.ranks[0] === 2) shallower++;
      else if (material > 100) deeper++;
      else if (material < -100) shallower++;
    }
    expect(deeper).toBeGreaterThanOrEqual(shallower);
  }, 120_000);
});
