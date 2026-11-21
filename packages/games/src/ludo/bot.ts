// Ludo computer players (ADR 0049): only in solo games. Easy moves at random. Medium weighs
// simple goals for the piece it moves. Hard values the whole board (progress, risk priced by
// what each piece stands to lose, threats, the leader counted most) and looks one roll ahead.
// Over 400 seeded two-player games: Medium beats Easy 84%, Hard beats Easy 92% and Medium 65%.
import { HOME, LAST_TRACK, SAFE_INDEXES, trackIndex, TRACK_LENGTH, YARD } from './board';
import {
  isActive,
  legalTokens,
  move,
  roll,
  totalProgress,
  type LudoState,
  type MoveResult,
} from './rules';
import type { Random } from '../core/random';
import type { BotLevel } from '../core/types';

/** The piece a computer player moves with the rolled die (the state must be in `move`). */
export function chooseLudoToken(state: LudoState, level: BotLevel, random: Random): number {
  const legal = legalTokens(state);
  if (legal.length === 0) throw new Error('no legal move');
  if (level === 'easy' || legal.length === 1) return legal[random.int(legal.length)]!;
  const scored = legal.map((token) => {
    const result = move(state, token);
    return { token, score: level === 'hard' ? hardScore(result) : mediumScore(state, result) };
  });
  const best = Math.max(...scored.map((entry) => entry.score));
  const top = scored.filter((entry) => entry.score >= best - 1e-6);
  return top[random.int(top.length)]!.token;
}

// Medium: goals for the moved piece only (finish, capture, leave the yard, get safe, advance).
function mediumScore(before: LudoState, result: MoveResult): number {
  const { seat, from, to, captures } = result;
  const player = before.players[seat]!;
  let value = (to - Math.max(from, 0)) * 0.8;
  if (to === HOME) value += 100;
  if (from === YARD) value += 55;
  if (from <= LAST_TRACK && to > LAST_TRACK && to < HOME) value += 25;
  for (const capture of captures) value += 70 + (capture.from + 1) * 0.6;
  // Risk where the piece stood and where it lands (after any capture took a threat away).
  const fromRisk = onPlainSquare(player.color, from) ? hitChance(before, seat, from) : 0;
  const toRisk = onPlainSquare(player.color, to) ? hitChance(result.state, seat, to) : 0;
  return value + fromRisk * 35 - toRisk * 45;
}

// Hard: the board after the move, averaged over the next roll. If the opponent moves next,
// they answer with their own best move; after a 6, a capture or a finish it is our own roll.
function hardScore(result: MoveResult): number {
  const seat = result.seat;
  const after = result.state;
  if (after.phase === 'over') return boardValue(after, seat);
  let total = 0;
  for (let die = 1; die <= 6; die++) {
    const rolled = roll(after, die);
    let next = rolled.state;
    if (rolled.outcome === 'move') {
      const mover = next.current;
      let best = -Infinity;
      let chosen = next;
      for (const token of legalTokens(next)) {
        const candidate = move(next, token).state;
        const value = boardValue(candidate, mover);
        if (value > best) {
          best = value;
          chosen = candidate;
        }
      }
      next = chosen;
    }
    total += boardValue(next, seat);
  }
  return total / 6;
}

// The mover's pieces minus the opponents' (the leader counts most). Each piece is worth how
// far it came, less what it may lose before its owner moves again, plus what it may hit.
function boardValue(state: LudoState, seat: number): number {
  const opponents = state.players
    .map((player, i) => ({ player, i }))
    .filter(({ player, i }) => i !== seat && isActive(player));
  const leader = Math.max(0, ...opponents.map(({ player }) => totalProgress(player)));
  let value = sideValue(state, seat);
  for (const { player, i } of opponents) {
    const weight = (totalProgress(player) >= leader ? 1.4 : 1) / Math.max(1, opponents.length);
    value -= weight * sideValue(state, i);
  }
  return value;
}

function sideValue(state: LudoState, seat: number): number {
  const player = state.players[seat]!;
  if (player.rank !== null) return 400;
  let value = 0;
  for (const progress of player.tokens) {
    if (progress === YARD) continue;
    if (progress === HOME) {
      value += 95;
      continue;
    }
    const stake = 12 + progress;
    value += progress > LAST_TRACK ? 72 + (progress - LAST_TRACK) * 2 : stake;
    if (onPlainSquare(player.color, progress))
      value -= hitChance(state, seat, progress) * stake * 1.15;
    value += attackChance(state, seat, progress) * 0.35;
  }
  return value;
}

// What a piece threatens: the stakes of opposing pieces 1–6 squares ahead on plain squares.
function attackChance(state: LudoState, seat: number, progress: number): number {
  const player = state.players[seat]!;
  const from = trackIndex(player.color, progress);
  if (from === null) return 0;
  let total = 0;
  state.players.forEach((other, otherSeat) => {
    if (otherSeat === seat || !isActive(other)) return;
    for (const q of other.tokens) {
      const at = trackIndex(other.color, q);
      if (at === null || SAFE_INDEXES.has(at)) continue;
      const distance = (at - from + TRACK_LENGTH) % TRACK_LENGTH;
      if (distance >= 1 && distance <= 6 && progress + distance <= LAST_TRACK) {
        total += (12 + q) / 6;
      }
    }
  });
  return total;
}

function onPlainSquare(color: LudoState['players'][number]['color'], progress: number): boolean {
  const index = trackIndex(color, progress);
  return index !== null && !SAFE_INDEXES.has(index);
}

/**
 * The chance some opponent can land on the mover's piece at `progress` in their next roll
 * (one roll each; extra rolls ignored).
 */
function hitChance(state: LudoState, seat: number, progress: number): number {
  const color = state.players[seat]!.color;
  const target = trackIndex(color, progress);
  if (target === null) return 0;
  let miss = 1;
  state.players.forEach((other, otherSeat) => {
    if (otherSeat === seat || !isActive(other)) return;
    const distances = new Set<number>();
    for (const q of other.tokens) {
      const at = trackIndex(other.color, q);
      if (at === null) continue;
      const distance = (target - at + TRACK_LENGTH) % TRACK_LENGTH;
      if (distance >= 1 && distance <= 6 && q + distance <= LAST_TRACK) distances.add(distance);
    }
    miss *= 1 - distances.size / 6;
  });
  return 1 - miss;
}
