// Chess (Phase 44) on the turn-game frame: full rules (castling, en passant, promotion, check,
// mate, stalemate, threefold repetition, the fifty-move rule, insufficient material), draw offers
// that travel with a move, and resigning (a leave). No timers: games with friends are slow play
// (ADR 0049). The state keeps the position as FEN, the repetition keys since the last pawn move
// or capture, and the moves in SAN.
import { GameType } from '@pingdost/protocol';

import { chooseChessMove } from './bot';
import {
  BISHOP,
  from88,
  KNIGHT,
  moveFlag,
  moveFrom,
  movePromotion,
  moveTo,
  PAWN,
  Position,
  QUEEN,
  ROOK,
  squareName,
  START_FEN,
  to88,
  FLAG_CASTLE,
  type Move,
} from './position';
import {
  leaveSeat,
  placesDraw,
  placesWithWinner,
  restoreCore,
  turnCore,
  type TurnCore,
  type TurnRules,
} from '../core/turn';

export type ChessSide = 'random' | 'white' | 'black';

export interface ChessSettings {
  /** The host's side (solo: the user's). */
  hostSide: ChessSide;
}

export type ChessEnd =
  'checkmate' | 'stalemate' | 'repetition' | 'fifty-moves' | 'material' | 'agreed' | 'resigned';

export interface ChessState extends TurnCore {
  fen: string;
  /** The seat playing White. */
  white: number;
  /** Repetition keys since the last pawn move or capture, this position last. */
  keys: string[];
  /** Every move so far in SAN. */
  san: string[];
  /** The last move's squares (0..63), for the board's highlight. */
  lastMove: { from: number; to: number } | null;
  /** The seat that offered a draw with its last move, if the offer stands. */
  drawOffer: number | null;
  end: ChessEnd | null;
  settings: ChessSettings;
}

/** A move (squares 0..63; promotion 2 knight, 3 bishop, 4 rook, 5 queen), or taking a draw offer. */
export type ChessMove =
  { from: number; to: number; promotion?: number; offerDraw?: boolean } | { acceptDraw: true };

export const DEFAULT_CHESS_SETTINGS: ChessSettings = { hostSide: 'random' };

export function normalizeChessSettings(raw: unknown): ChessSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const side = value.hostSide;
  return { hostSide: side === 'white' || side === 'black' ? side : 'random' };
}

const SIDE_WIRE: Record<ChessSide, number> = { random: 0, white: 1, black: 2 };

export function chessSideOf(state: Pick<ChessState, 'white'>, seat: number): 'white' | 'black' {
  return seat === state.white ? 'white' : 'black';
}

export function chessPosition(state: Pick<ChessState, 'fen'>): Position {
  return Position.fromFen(state.fen);
}

const LETTERS = ['', '', 'N', 'B', 'R', 'Q', 'K'];

/** A move in standard algebraic notation ("Nf3", "exd5", "O-O", "e8=Q+", "Qh4#"). */
export function sanOf(position: Position, move: Move): string {
  const from = moveFrom(move);
  const to = moveTo(move);
  const piece = Math.abs(position.board[from]!);
  let san: string;
  if (moveFlag(move) === FLAG_CASTLE) {
    san = to > from ? 'O-O' : 'O-O-O';
  } else {
    const capture = position.board[to] !== 0 || (piece === PAWN && (from & 7) !== (to & 7));
    const target = squareName(from88(to));
    if (piece === PAWN) {
      san = capture ? `${'abcdefgh'[from & 7]}x${target}` : target;
      const promo = movePromotion(move);
      if (promo) san += `=${LETTERS[promo]}`;
    } else {
      // Tell apart two like pieces that could both go there.
      const rivals = position
        .legalMoves()
        .filter(
          (m) => m !== move && moveTo(m) === to && Math.abs(position.board[moveFrom(m)]!) === piece,
        );
      let which = '';
      if (rivals.length > 0) {
        const sameFile = rivals.some((m) => (moveFrom(m) & 7) === (from & 7));
        const sameRank = rivals.some((m) => moveFrom(m) >> 4 === from >> 4);
        const name = squareName(from88(from));
        which = !sameFile ? name[0]! : !sameRank ? name[1]! : name;
      }
      san = `${LETTERS[piece]}${which}${capture ? 'x' : ''}${target}`;
    }
  }
  if (!position.make(move)) return san;
  const check = position.inCheck();
  const mate = check && position.legalMoves().length === 0;
  position.unmake();
  return `${san}${mate ? '#' : check ? '+' : ''}`;
}

/** The engine move for a wire/UI move, if it is legal. */
export function findMove(
  position: Position,
  move: { from: number; to: number; promotion?: number },
): Move | null {
  if (!Number.isInteger(move.from) || !Number.isInteger(move.to)) return null;
  if (move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) return null;
  const from = to88(move.from);
  const to = to88(move.to);
  const promotion = move.promotion ?? 0;
  return (
    position
      .legalMoves()
      .find((m) => moveFrom(m) === from && moveTo(m) === to && movePromotion(m) === promotion) ??
    null
  );
}

/** The side to move is in check (and the game is not over). */
export function chessInCheck(state: ChessState): boolean {
  return !state.ranks && chessPosition(state).inCheck();
}

/** Whether moving from → to is a pawn reaching the last rank (the UI asks which piece). */
export function isPromotion(state: ChessState, from: number, to: number): boolean {
  const position = chessPosition(state);
  const piece = position.pieceAt(from);
  return Math.abs(piece) === PAWN && (to >> 3 === 7 || to >> 3 === 0);
}

function setup(seats: number, settings: ChessSettings, first: number): ChessState {
  const position = Position.fromFen(START_FEN);
  return {
    ...turnCore(seats, first),
    fen: START_FEN,
    white: first,
    keys: [position.fen(true)],
    san: [],
    lastMove: null,
    drawOffer: null,
    end: null,
    settings,
  };
}

function legal(state: ChessState): ChessMove[] {
  if (state.ranks) return [];
  return chessPosition(state)
    .legalMoves()
    .map((m) => {
      const promotion = movePromotion(m);
      return {
        from: from88(moveFrom(m)),
        to: from88(moveTo(m)),
        ...(promotion ? { promotion } : {}),
      };
    });
}

function isLegal(state: ChessState, move: ChessMove): boolean {
  if (state.ranks) return false;
  if ('acceptDraw' in move) return state.drawOffer !== null && state.drawOffer !== state.current;
  return findMove(chessPosition(state), move) !== null;
}

function apply(state: ChessState, move: ChessMove): ChessState {
  if (!isLegal(state, move)) return state;
  if ('acceptDraw' in move) {
    const next: ChessState = { ...state, turns: state.turns + 1, drawOffer: null, end: 'agreed' };
    return { ...next, ranks: placesDraw(next) };
  }
  const position = chessPosition(state);
  const engineMove = findMove(position, move)!;
  const san = sanOf(position, engineMove);
  position.make(engineMove);
  const key = position.fen(true);
  const keys = position.halfmove === 0 ? [key] : [...state.keys, key];
  const mover = state.current;
  const next: ChessState = {
    ...state,
    fen: position.fen(),
    keys,
    san: [...state.san, san],
    lastMove: { from: move.from, to: move.to },
    drawOffer: move.offerDraw ? mover : null,
    turns: state.turns + 1,
    current: 1 - mover,
  };
  const replies = position.legalMoves().length;
  if (replies === 0) {
    if (position.inCheck())
      return { ...next, end: 'checkmate', ranks: placesWithWinner(next, mover) };
    return { ...next, end: 'stalemate', ranks: placesDraw(next) };
  }
  if (keys.filter((k) => k === key).length >= 3) {
    return { ...next, end: 'repetition', ranks: placesDraw(next) };
  }
  if (position.halfmove >= 100) return { ...next, end: 'fifty-moves', ranks: placesDraw(next) };
  if (position.insufficientMaterial()) return { ...next, end: 'material', ranks: placesDraw(next) };
  return next;
}

const END_TEXT: Record<ChessEnd, string> = {
  checkmate: 'Checkmate',
  stalemate: 'Stalemate: a draw',
  repetition: 'Draw by threefold repetition',
  'fifty-moves': 'Draw by the fifty-move rule',
  material: 'Draw: neither side can checkmate',
  agreed: 'Draw agreed',
  resigned: 'By resignation',
};

const PROMOTION_WIRE = new Set([KNIGHT, BISHOP, ROOK, QUEEN]);

export const CHESS: TurnRules<ChessState, ChessMove, ChessSettings> = {
  id: 'chess',
  wireType: GameType.CHESS,
  minPlayers: 2,
  maxPlayers: 2,
  dice: false,
  levels: true,
  turnMs: null,
  defaultSettings: DEFAULT_CHESS_SETTINGS,
  normalizeSettings: normalizeChessSettings,
  settingsToWire: (settings) => ({
    case: 'chess',
    value: { hostSide: SIDE_WIRE[settings.hostSide] },
  }),
  settingsFromWire: (create) => {
    if (create.settings.case !== 'chess') return DEFAULT_CHESS_SETTINGS;
    const side = create.settings.value.hostSide;
    return { hostSide: side === 1 ? 'white' : side === 2 ? 'black' : 'random' };
  },
  firstSeat: (settings, drawn, host, seats) =>
    settings.hostSide === 'white'
      ? host
      : settings.hostSide === 'black'
        ? (host + 1) % seats
        : drawn,
  setup,
  legal,
  isLegal,
  apply,
  skip: (state) => state,
  leave: (state, seat) => {
    const next = leaveSeat(state, seat);
    return next.ranks && !state.ranks ? { ...next, end: 'resigned', drawOffer: null } : next;
  },
  bot: (state, level, random) => chooseChessMove(state, level, random),
  moveToWire: (move) => ({
    case: 'chess',
    value:
      'acceptDraw' in move
        ? { acceptDraw: true }
        : {
            from: move.from,
            to: move.to,
            promotion: move.promotion ?? 0,
            offerDraw: move.offerDraw ?? false,
          },
  }),
  moveFromWire: (wire) => {
    if (wire.play.case !== 'chess') return null;
    const v = wire.play.value;
    if (v.acceptDraw) return { acceptDraw: true };
    if (v.promotion !== 0 && !PROMOTION_WIRE.has(v.promotion)) return null;
    return {
      from: v.from,
      to: v.to,
      ...(v.promotion ? { promotion: v.promotion } : {}),
      ...(v.offerDraw ? { offerDraw: true } : {}),
    };
  },
  sameMove: (a, b) => {
    if ('acceptDraw' in a || 'acceptDraw' in b) return 'acceptDraw' in a && 'acceptDraw' in b;
    return a.from === b.from && a.to === b.to && (a.promotion ?? 0) === (b.promotion ?? 0);
  },
  canonical: (s) =>
    [
      s.fen,
      s.white,
      s.current,
      s.turns,
      s.keys.join(';'),
      s.drawOffer ?? '-',
      s.end ?? '-',
      s.left.map(Number).join(''),
      s.ranks?.join(',') ?? '-',
    ].join('|'),
  restore(raw) {
    const core = restoreCore(raw, 2, 2);
    if (!core) return null;
    const s = raw as Partial<ChessState>;
    if (typeof s.fen !== 'string' || (s.white !== 0 && s.white !== 1)) return null;
    try {
      Position.fromFen(s.fen);
    } catch {
      return null;
    }
    const strings = (v: unknown) =>
      Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : null;
    const keys = strings(s.keys);
    const san = strings(s.san);
    if (!keys || !san) return null;
    const last = s.lastMove;
    const lastMove =
      last && Number.isInteger(last.from) && Number.isInteger(last.to)
        ? { from: last.from, to: last.to }
        : null;
    return {
      ...core,
      fen: s.fen,
      white: s.white,
      keys,
      san,
      lastMove,
      drawOffer: s.drawOffer === 0 || s.drawOffer === 1 ? s.drawOffer : null,
      end: typeof s.end === 'string' && s.end in END_TEXT ? s.end : null,
      settings: normalizeChessSettings(s.settings),
    };
  },
  sideName: (state, seat) => (chessSideOf(state, seat) === 'white' ? 'White' : 'Black'),
  rulesText: (settings) => [
    'The usual rules of chess: castling, en passant and promotion included.',
    'Checkmate wins. Stalemate, threefold repetition, fifty moves without a capture or pawn move, and positions where neither side can checkmate are draws.',
    'You can offer a draw with your move; your opponent accepts on their turn, or plays on.',
    settings.hostSide === 'random'
      ? 'Who plays White is drawn at the start. White moves first.'
      : `The host plays ${settings.hostSide === 'white' ? 'White' : 'Black'}. White moves first.`,
    'No clock: games with friends are played at your own pace.',
  ],
  resultDetail: (state) => (state.end ? END_TEXT[state.end] : null),
  stepMs: (step, pace) => (step.kind === 'leave' ? pace.read : pace.step + 60),
};
