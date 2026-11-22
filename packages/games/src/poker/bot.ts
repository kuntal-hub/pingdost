// Poker computer players (Phase 47; solo games only, ADR 0049). They see their own two cards,
// the board and the betting, never the deck or anyone else's cards. Each one estimates its
// chance to win by dealing out the unseen cards many times (more often at higher levels) and
// weighs it against the pot odds:
// - Easy misjudges its hands (noise), calls too much and bluffs at random;
// - Medium bets good hands, calls when the price is right, bluffs now and then;
// - Hard also reads raises (a raiser's cards are dealt from stronger starts), sizes bets by
//   strength and stack depth, and bluffs or semi-bluffs against one or two players.
import { handScore, startingStrength } from './hands';
import {
  liveSeats,
  potRaise,
  potTotal,
  raiseRange,
  type PokerMove,
  type PokerState,
} from './rules';
import { seededRandom, type Random } from '../core/random';
import type { BotLevel } from '../core/types';

/**
 * The chance (ties count in part) that `hole` beats `opponents` hands on this board, from
 * `samples` random deals of the unseen cards. `minStrength[i]` > 0 deals opponent i only
 * starting hands at least that good (a few tries).
 */
export function estimateEquity(
  hole: readonly number[],
  board: readonly number[],
  opponents: number,
  samples: number,
  random: Random,
  minStrength: readonly number[] = [],
): number {
  if (opponents <= 0) return 1;
  const known = new Set([...hole, ...board]);
  const pool: number[] = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) pool.push(c);
  const need = 5 - board.length;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    // A partial shuffle from the end: each sample draws from the whole pool again.
    let top = pool.length;
    const draw = () => {
      const j = random.int(top);
      top--;
      const card = pool[j]!;
      pool[j] = pool[top]!;
      pool[top] = card;
      return card;
    };
    const full = [...board];
    for (let k = 0; k < need; k++) full.push(draw());
    const mine = handScore([...hole, ...full]);
    let beaten = false;
    let ties = 0;
    for (let o = 0; o < opponents; o++) {
      let a = draw();
      let b = draw();
      const min = minStrength[o] ?? 0;
      for (let t = 0; t < 3 && min > 0 && top >= 2 && startingStrength(a, b) < min; t++) {
        a = draw();
        b = draw();
      }
      const theirs = handScore([a, b, ...full]);
      if (theirs > mine) {
        beaten = true;
        break;
      }
      if (theirs === mine) ties++;
    }
    if (!beaten) total += 1 / (ties + 1);
  }
  return total / samples;
}

/** Whether a seat has shown strength this hand (bet or raised, or put in a lot). */
function aggressive(state: PokerState, seat: number): boolean {
  const act = state.actions[seat]?.act;
  return act === 'bet' || act === 'raise' || state.contrib[seat]! > 3 * state.bb;
}

const SAMPLES: Record<BotLevel, number> = { easy: 50, medium: 140, hard: 260 };

export function choosePokerMove(state: PokerState, level: BotLevel, random: Random): PokerMove {
  // Dealing is never a player's choice (solo games run it as `auto` steps).
  if (state.phase !== 'bet') return { next: true };
  const seat = state.current;
  const hole = state.holes[seat] ?? [];
  const owe = state.bet - state.bets[seat]!;
  const pass: PokerMove = owe > 0 ? { act: 'fold' } : { act: 'check' };
  const call: PokerMove = owe > 0 ? { act: 'call' } : { act: 'check' };
  if (hole.length !== 2 || hole[0]! < 0) return pass;

  const live = liveSeats(state);
  const others = live.filter((s) => s !== seat);
  const ranges = level === 'hard' ? others.map((s) => (aggressive(state, s) ? 0.45 : 0)) : [];
  const equity = estimateEquity(
    hole,
    state.board,
    others.length,
    SAMPLES[level],
    seededRandom(random.int(0x7fffffff)),
    ranges,
  );
  const pot = potTotal(state);
  const odds = owe > 0 ? owe / (pot + owe) : 0;
  const range = raiseRange(state);
  const raise = (share: number): PokerMove =>
    range
      ? { act: 'raise', to: Math.min(range.max, Math.max(range.min, potRaise(state, share))) }
      : call;
  // 1 is an average hand for this many players; 2 is twice the fair share of the pot.
  const strength = equity * live.length;
  const r = random.next();
  const stack = state.stacks[seat]!;
  const allIn = owe >= stack;
  const flopped = state.board.length > 0;

  switch (level) {
    case 'easy': {
      const guess = equity + (random.next() - 0.5) * 0.3;
      if (owe === 0) {
        if (strength > 1.6 && r < 0.5) return raise(0.5);
        return r < 0.06 ? raise(0.33) : call;
      }
      if (strength > 2 && r < 0.3) return raise(0.5);
      return guess >= odds - 0.12 || r < 0.12 ? call : pass;
    }
    case 'medium': {
      if (owe === 0) {
        if (strength > 1.5) return raise(r < 0.5 ? 0.5 : 0.75);
        if (flopped && others.length <= 2 && strength < 0.8 && r < 0.08) return raise(0.5);
        return call;
      }
      if (strength > 1.9 && range) return raise(0.75);
      return equity >= odds + (allIn ? 0.08 : 0.03) ? call : pass;
    }
    case 'hard': {
      const spr = stack / Math.max(1, pot);
      const fewOpponents = others.length <= 2;
      if (owe === 0) {
        // Bet for value more often than Medium (players call light), bigger when strong.
        if (strength > 1.15) return raise(strength > 1.6 ? 0.8 : 0.5);
        const bluffing = fewOpponents && flopped && state.board.length < 5;
        return bluffing && strength < 0.6 && r < 0.05 ? raise(0.5) : call;
      }
      if (strength > 1.6 && range) return raise(spr < 2 ? 100 : 0.8);
      // A bet after the flop usually means a made hand: ask for more than the bare price.
      const margin = allIn ? 0.08 : flopped ? 0.06 : 0.02;
      return equity >= odds + margin ? call : pass;
    }
  }
}
