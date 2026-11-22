// Chess positions and moves (Phase 44): PingDost's own move generator on a 0x88 board, with
// make/unmake for the search and FEN in and out. Squares outside the core are 0..63 (a1 = 0,
// h1 = 7, a8 = 56); inside, 0x88 (rank * 16 + file). Pieces: 1 pawn, 2 knight, 3 bishop, 4 rook,
// 5 queen, 6 king; positive for White, negative for Black.

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export type Side = 1 | -1;

/** A move as a number: from (7 bits) | to << 7 | promotion << 14 | flag << 17 (0x88 squares). */
export type Move = number;
export const FLAG_DOUBLE = 1;
export const FLAG_EN_PASSANT = 2;
export const FLAG_CASTLE = 3;

export const moveFrom = (m: Move) => m & 0x7f;
export const moveTo = (m: Move) => (m >> 7) & 0x7f;
export const movePromotion = (m: Move) => (m >> 14) & 0x7;
export const moveFlag = (m: Move) => (m >> 17) & 0x3;
const makeMove = (from: number, to: number, promotion = 0, flag = 0): Move =>
  from | (to << 7) | (promotion << 14) | (flag << 17);

export const to88 = (sq: number) => ((sq >> 3) << 4) | (sq & 7);
export const from88 = (sq: number) => ((sq >> 4) << 3) | (sq & 7);

const FILES = 'abcdefgh';
/** "e4" for a 0..63 square. */
export function squareName(sq: number): string {
  return `${FILES[sq & 7]}${(sq >> 3) + 1}`;
}

export function parseSquare(name: string): number {
  const file = FILES.indexOf(name[0] ?? '');
  const rank = Number(name[1]) - 1;
  return file < 0 || !(rank >= 0 && rank < 8) ? -1 : rank * 8 + file;
}

const CASTLE_WK = 1;
const CASTLE_WQ = 2;
const CASTLE_BK = 4;
const CASTLE_BQ = 8;

const KNIGHT_STEPS = [33, 31, 18, 14, -33, -31, -18, -14];
const KING_STEPS = [16, -16, 1, -1, 17, 15, -17, -15];
const BISHOP_STEPS = [17, 15, -17, -15];
const ROOK_STEPS = [16, -16, 1, -1];

/** Castling rights kept after a move touches this square (rooks' and kings' home squares). */
const CASTLE_KEEP = new Uint8Array(128).fill(15);
CASTLE_KEEP[0x00] = 15 & ~CASTLE_WQ;
CASTLE_KEEP[0x07] = 15 & ~CASTLE_WK;
CASTLE_KEEP[0x04] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_KEEP[0x70] = 15 & ~CASTLE_BQ;
CASTLE_KEEP[0x77] = 15 & ~CASTLE_BK;
CASTLE_KEEP[0x74] = 15 & ~(CASTLE_BK | CASTLE_BQ);

const PIECE_LETTERS = ' pnbrqk';

interface Undo {
  move: Move;
  captured: number;
  castling: number;
  ep: number;
  halfmove: number;
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export class Position {
  board = new Int8Array(128);
  side: Side = 1;
  castling = 0;
  /** The en-passant target square (0x88), or −1. */
  ep = -1;
  halfmove = 0;
  fullmove = 1;
  kings: [number, number] = [-1, -1];
  #undo: Undo[] = [];

  static fromFen(fen: string): Position {
    const p = new Position();
    const [placement, side, castling, ep, half, full] = fen.trim().split(/\s+/);
    if (!placement || !side) throw new Error('bad FEN');
    const rows = placement.split('/');
    if (rows.length !== 8) throw new Error('bad FEN');
    rows.forEach((row, i) => {
      const rank = 7 - i;
      let file = 0;
      for (const ch of row) {
        if (/[1-8]/.test(ch)) {
          file += Number(ch);
          continue;
        }
        const type = PIECE_LETTERS.indexOf(ch.toLowerCase());
        if (type < 1 || file > 7) throw new Error('bad FEN');
        const piece = ch === ch.toUpperCase() ? type : -type;
        const sq = rank * 16 + file;
        p.board[sq] = piece;
        if (type === KING) p.kings[piece > 0 ? 0 : 1] = sq;
        file++;
      }
      if (file !== 8) throw new Error('bad FEN');
    });
    if (p.kings[0] < 0 || p.kings[1] < 0) throw new Error('bad FEN: a king is missing');
    if (side !== 'w' && side !== 'b') throw new Error('bad FEN');
    p.side = side === 'w' ? 1 : -1;
    p.castling = 0;
    for (const ch of castling ?? '-') {
      if (ch === 'K') p.castling |= CASTLE_WK;
      if (ch === 'Q') p.castling |= CASTLE_WQ;
      if (ch === 'k') p.castling |= CASTLE_BK;
      if (ch === 'q') p.castling |= CASTLE_BQ;
    }
    const epSq = ep && ep !== '-' ? parseSquare(ep) : -1;
    p.ep = epSq >= 0 ? to88(epSq) : -1;
    p.halfmove = Number(half ?? 0) || 0;
    p.fullmove = Number(full ?? 1) || 1;
    return p;
  }

  /** The position as FEN; `key` leaves out the move counters (for repetitions). */
  fen(key = false): string {
    const rows: string[] = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = '';
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = this.board[rank * 16 + file]!;
        if (piece === 0) {
          empty++;
          continue;
        }
        if (empty) row += empty;
        empty = 0;
        const letter = PIECE_LETTERS[Math.abs(piece)]!;
        row += piece > 0 ? letter.toUpperCase() : letter;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    let castling = '';
    if (this.castling & CASTLE_WK) castling += 'K';
    if (this.castling & CASTLE_WQ) castling += 'Q';
    if (this.castling & CASTLE_BK) castling += 'k';
    if (this.castling & CASTLE_BQ) castling += 'q';
    // The en-passant square counts only when a capture there is possible (as for repetitions).
    const ep = this.ep >= 0 && this.#epCapturable() ? squareName(from88(this.ep)) : '-';
    const base = `${rows.join('/')} ${this.side === 1 ? 'w' : 'b'} ${castling || '-'} ${ep}`;
    return key ? base : `${base} ${this.halfmove} ${this.fullmove}`;
  }

  #epCapturable(): boolean {
    const pawn = this.side;
    const from = this.ep - 16 * pawn;
    for (const d of [-1, 1]) {
      const sq = from + d;
      if (!(sq & 0x88) && this.board[sq] === pawn * PAWN) return true;
    }
    return false;
  }

  /** Whether `sq` is attacked by `by`. */
  attacked(sq: number, by: Side): boolean {
    const b = this.board;
    // Pawns attack diagonally forward: a White pawn on sq − 15 or sq − 17 attacks sq.
    const pawnFrom = by === 1 ? [sq - 15, sq - 17] : [sq + 15, sq + 17];
    for (const s of pawnFrom) if (!(s & 0x88) && b[s] === by * PAWN) return true;
    for (const d of KNIGHT_STEPS) {
      const s = sq + d;
      if (!(s & 0x88) && b[s] === by * KNIGHT) return true;
    }
    for (const d of KING_STEPS) {
      const s = sq + d;
      if (!(s & 0x88) && b[s] === by * KING) return true;
    }
    for (const d of BISHOP_STEPS) {
      for (let s = sq + d; !(s & 0x88); s += d) {
        const piece = b[s]!;
        if (piece === 0) continue;
        if (piece === by * BISHOP || piece === by * QUEEN) return true;
        break;
      }
    }
    for (const d of ROOK_STEPS) {
      for (let s = sq + d; !(s & 0x88); s += d) {
        const piece = b[s]!;
        if (piece === 0) continue;
        if (piece === by * ROOK || piece === by * QUEEN) return true;
        break;
      }
    }
    return false;
  }

  inCheck(side: Side = this.side): boolean {
    return this.attacked(this.kings[side === 1 ? 0 : 1], -side as Side);
  }

  /** Moves that obey piece movement; some may leave the king in check. `captures` limits them. */
  pseudoMoves(captures = false): Move[] {
    const out: Move[] = [];
    const b = this.board;
    const us = this.side;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) {
        sq += 7;
        continue;
      }
      const piece = b[sq]!;
      if (piece === 0 || Math.sign(piece) !== us) continue;
      const type = Math.abs(piece);
      if (type === PAWN) {
        const step = 16 * us;
        const startRank = us === 1 ? 1 : 6;
        const lastRank = us === 1 ? 7 : 0;
        const one = sq + step;
        const push = (to: number, flag = 0) => {
          if (to >> 4 === lastRank) {
            for (const promo of [QUEEN, KNIGHT, ROOK, BISHOP])
              out.push(makeMove(sq, to, promo, flag));
          } else {
            out.push(makeMove(sq, to, 0, flag));
          }
        };
        if (!captures && !(one & 0x88) && b[one] === 0) {
          push(one);
          const two = one + step;
          if (sq >> 4 === startRank && b[two] === 0) out.push(makeMove(sq, two, 0, FLAG_DOUBLE));
        } else if (captures && !(one & 0x88) && b[one] === 0 && one >> 4 === lastRank) {
          push(one);
        }
        for (const d of [step - 1, step + 1]) {
          const to = sq + d;
          if (to & 0x88) continue;
          if (b[to] !== 0 && Math.sign(b[to]!) === -us) push(to);
          else if (to === this.ep) out.push(makeMove(sq, to, 0, FLAG_EN_PASSANT));
        }
        continue;
      }
      if (type === KNIGHT || type === KING) {
        for (const d of type === KNIGHT ? KNIGHT_STEPS : KING_STEPS) {
          const to = sq + d;
          if (to & 0x88) continue;
          const target = b[to]!;
          if (target === 0 ? !captures : Math.sign(target) === -us) out.push(makeMove(sq, to));
        }
        if (type === KING && !captures) this.#castles(sq, out);
        continue;
      }
      const steps = type === BISHOP ? BISHOP_STEPS : type === ROOK ? ROOK_STEPS : KING_STEPS;
      for (const d of steps) {
        for (let to = sq + d; !(to & 0x88); to += d) {
          const target = b[to]!;
          if (target === 0) {
            if (!captures) out.push(makeMove(sq, to));
            continue;
          }
          if (Math.sign(target) === -us) out.push(makeMove(sq, to));
          break;
        }
      }
    }
    return out;
  }

  #castles(king: number, out: Move[]): void {
    const b = this.board;
    const us = this.side;
    const home = us === 1 ? 0x04 : 0x74;
    if (king !== home) return;
    const them = -us as Side;
    const [kingSide, queenSide] = us === 1 ? [CASTLE_WK, CASTLE_WQ] : [CASTLE_BK, CASTLE_BQ];
    if (
      this.castling & kingSide &&
      b[home + 1] === 0 &&
      b[home + 2] === 0 &&
      b[home + 3] === us * ROOK &&
      !this.attacked(home, them) &&
      !this.attacked(home + 1, them) &&
      !this.attacked(home + 2, them)
    ) {
      out.push(makeMove(home, home + 2, 0, FLAG_CASTLE));
    }
    if (
      this.castling & queenSide &&
      b[home - 1] === 0 &&
      b[home - 2] === 0 &&
      b[home - 3] === 0 &&
      b[home - 4] === us * ROOK &&
      !this.attacked(home, them) &&
      !this.attacked(home - 1, them) &&
      !this.attacked(home - 2, them)
    ) {
      out.push(makeMove(home, home - 2, 0, FLAG_CASTLE));
    }
  }

  /** Plays a move (assumed pseudo-legal). Returns false, undone, if it leaves the king in check. */
  make(move: Move): boolean {
    const b = this.board;
    const from = moveFrom(move);
    const to = moveTo(move);
    const flag = moveFlag(move);
    const promotion = movePromotion(move);
    const piece = b[from]!;
    const us = this.side;
    let captured = b[to]!;
    this.#undo.push({
      move,
      captured,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
    });
    if (flag === FLAG_EN_PASSANT) {
      const victim = to - 16 * us;
      captured = b[victim]!;
      this.#undo[this.#undo.length - 1]!.captured = captured;
      b[victim] = 0;
    }
    b[to] = promotion ? us * promotion : piece;
    b[from] = 0;
    if (flag === FLAG_CASTLE) {
      const kingSide = to > from;
      const rookFrom = kingSide ? from + 3 : from - 4;
      const rookTo = kingSide ? from + 1 : from - 1;
      b[rookTo] = b[rookFrom]!;
      b[rookFrom] = 0;
    }
    if (Math.abs(piece) === KING) this.kings[us === 1 ? 0 : 1] = to;
    this.castling &= CASTLE_KEEP[from]! & CASTLE_KEEP[to]!;
    this.ep = flag === FLAG_DOUBLE ? from + 16 * us : -1;
    this.halfmove = Math.abs(piece) === PAWN || captured !== 0 ? 0 : this.halfmove + 1;
    if (us === -1) this.fullmove++;
    this.side = -us as Side;
    if (this.inCheck(us)) {
      this.unmake();
      return false;
    }
    return true;
  }

  unmake(): void {
    const undo = this.#undo.pop();
    if (!undo) return;
    const b = this.board;
    const { move } = undo;
    const from = moveFrom(move);
    const to = moveTo(move);
    const flag = moveFlag(move);
    const us = -this.side as Side;
    this.side = us;
    const moved = movePromotion(move) ? us * PAWN : b[to]!;
    b[from] = moved;
    if (flag === FLAG_EN_PASSANT) {
      b[to] = 0;
      b[to - 16 * us] = undo.captured;
    } else {
      b[to] = undo.captured;
    }
    if (flag === FLAG_CASTLE) {
      const kingSide = to > from;
      const rookFrom = kingSide ? from + 3 : from - 4;
      const rookTo = kingSide ? from + 1 : from - 1;
      b[rookFrom] = b[rookTo]!;
      b[rookTo] = 0;
    }
    if (Math.abs(moved) === KING) this.kings[us === 1 ? 0 : 1] = from;
    this.castling = undo.castling;
    this.ep = undo.ep;
    this.halfmove = undo.halfmove;
    if (us === -1) this.fullmove--;
  }

  /** Moves made and not yet unmade (a search unwinds to its root with this). */
  get depth(): number {
    return this.#undo.length;
  }

  /** Every legal move. */
  legalMoves(): Move[] {
    const out: Move[] = [];
    for (const move of this.pseudoMoves()) {
      if (this.make(move)) {
        out.push(move);
        this.unmake();
      }
    }
    return out;
  }

  /** Leaf positions `depth` plies deep (move-generator test). */
  perft(depth: number): number {
    if (depth === 0) return 1;
    let nodes = 0;
    for (const move of this.pseudoMoves()) {
      if (!this.make(move)) continue;
      nodes += depth === 1 ? 1 : this.perft(depth - 1);
      this.unmake();
    }
    return nodes;
  }

  /** Neither side can mate: bare kings, a lone minor piece, or bishops all on one color. */
  insufficientMaterial(): boolean {
    const minors: { type: number; color: number }[] = [];
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) {
        sq += 7;
        continue;
      }
      const type = Math.abs(this.board[sq]!);
      if (type === 0 || type === KING) continue;
      if (type === PAWN || type === ROOK || type === QUEEN) return false;
      minors.push({ type, color: ((sq >> 4) + (sq & 7)) % 2 });
    }
    if (minors.length <= 1) return true;
    return minors.every((m) => m.type === BISHOP && m.color === minors[0]!.color);
  }

  /** The piece on a 0..63 square (0 if empty). */
  pieceAt(sq: number): number {
    return this.board[to88(sq)]!;
  }
}
