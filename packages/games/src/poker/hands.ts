// Poker hands (Phase 47): the best five of five to seven cards as one number, so comparing
// hands is comparing numbers, and the hand's name for the table. Cards are 0–51 as in Call
// Bridge: suit × 13 + rank (0 = 2 … 12 = ace).

/** Hand categories, weakest first. */
export const HAND_CATEGORIES = [
  'High card',
  'Pair',
  'Two pair',
  'Three of a kind',
  'Straight',
  'Flush',
  'Full house',
  'Four of a kind',
  'Straight flush',
] as const;

const BASE = 16;
const CATEGORY = BASE ** 5;

function pack(category: number, ranks: readonly number[]): number {
  let score = category * CATEGORY;
  for (let i = 0; i < 5; i++) score += (ranks[i] ?? 0) * BASE ** (4 - i);
  return score;
}

/** The rank of a straight's top card in a mask of ranks, or −1. A-2-3-4-5 tops at the 5. */
function straightTop(mask: number): number {
  for (let top = 12; top >= 4; top--) {
    const need = 0b11111 << (top - 4);
    if ((mask & need) === need) return top;
  }
  return (mask & 0b1111) === 0b1111 && (mask & (1 << 12)) !== 0 ? 3 : -1;
}

/** The highest `count` ranks set in a mask, best first. */
function topRanks(mask: number, count: number, skip: readonly number[] = []): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < count; r--) {
    if ((mask & (1 << r)) !== 0 && !skip.includes(r)) out.push(r);
  }
  return out;
}

/** The best five of 5–7 cards: higher is better, equal scores tie. */
export function handScore(cards: readonly number[]): number {
  const counts = new Array<number>(13).fill(0);
  const suitCounts = [0, 0, 0, 0];
  const suitMasks = [0, 0, 0, 0];
  let mask = 0;
  for (const card of cards) {
    const rank = card % 13;
    const suit = (card - rank) / 13;
    counts[rank]!++;
    suitCounts[suit]!++;
    suitMasks[suit]! |= 1 << rank;
    mask |= 1 << rank;
  }
  let flush = -1;
  for (let s = 0; s < 4; s++) {
    if (suitCounts[s]! >= 5) {
      flush = suitMasks[s]!;
      const top = straightTop(flush);
      if (top >= 0) return pack(8, [top]);
    }
  }
  let quad = -1;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const n = counts[r]!;
    if (n === 4) quad = r;
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
  }
  if (quad >= 0) return pack(7, [quad, ...topRanks(mask, 1, [quad])]);
  if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
    const pair = Math.max(trips[1] ?? -1, pairs[0] ?? -1);
    return pack(6, [trips[0]!, pair]);
  }
  if (flush >= 0) return pack(5, topRanks(flush, 5));
  const straight = straightTop(mask);
  if (straight >= 0) return pack(4, [straight]);
  if (trips.length > 0) return pack(3, [trips[0]!, ...topRanks(mask, 2, [trips[0]!])]);
  if (pairs.length >= 2) {
    const [high, low] = pairs as [number, number];
    return pack(2, [high, low, ...topRanks(mask, 1, [high, low])]);
  }
  if (pairs.length === 1) return pack(1, [pairs[0]!, ...topRanks(mask, 3, [pairs[0]!])]);
  return pack(0, topRanks(mask, 5));
}

export function handCategory(score: number): number {
  return Math.floor(score / CATEGORY);
}

function rankAt(score: number, i: number): number {
  return Math.floor(score / BASE ** (4 - i)) % BASE;
}

const ONE = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const RANK = [...ONE, 'jack', 'queen', 'king', 'ace'];
const RANKS = [
  'twos',
  'threes',
  'fours',
  'fives',
  'sixes',
  'sevens',
  'eights',
  'nines',
  'tens',
  'jacks',
  'queens',
  'kings',
  'aces',
];

/** "Pair of kings", "Flush, ace high", "Full house, tens over fours", "Royal flush". */
export function handName(score: number): string {
  const top = rankAt(score, 0);
  switch (handCategory(score)) {
    case 8:
      return top === 12 ? 'Royal flush' : `Straight flush, ${RANK[top]} high`;
    case 7:
      return `Four ${RANKS[top]}`;
    case 6:
      return `Full house, ${RANKS[top]} over ${RANKS[rankAt(score, 1)]}`;
    case 5:
      return `Flush, ${RANK[top]} high`;
    case 4:
      return `Straight, ${RANK[top]} high`;
    case 3:
      return `Three ${RANKS[top]}`;
    case 2:
      return `Two pair, ${RANKS[top]} and ${RANKS[rankAt(score, 1)]}`;
    case 1:
      return `Pair of ${RANKS[top]}`;
    default:
      return `${RANK[top]![0]!.toUpperCase()}${RANK[top]!.slice(1)} high`;
  }
}

/** The hand inside a sentence: "a flush, ace high", "two pair, aces and fives", "ace high". */
export function handPhrase(score: number): string {
  const name = handName(score);
  const lower = `${name[0]!.toLowerCase()}${name.slice(1)}`;
  return [1, 4, 5, 6, 8].includes(handCategory(score)) ? `a ${lower}` : lower;
}

/** A short name for a strip or a label: "Flush", "Two pair". */
export function handShortName(score: number): string {
  return handCategory(score) === 8 && rankAt(score, 0) === 12
    ? 'Royal flush'
    : HAND_CATEGORIES[handCategory(score)]!;
}

/**
 * Before the flop: how good two cards are, 0 (7-2 offsuit) to 1 (aces). A quick rule of thumb
 * for the computer players and their guesses about others' hands.
 */
export function startingStrength(a: number, b: number): number {
  const ra = a % 13;
  const rb = b % 13;
  const high = Math.max(ra, rb);
  const low = Math.min(ra, rb);
  let points = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10][high]!;
  if (ra === rb) points = Math.max(5, points * 2);
  else {
    if (Math.floor(a / 13) === Math.floor(b / 13)) points += 2;
    const gap = high - low - 1;
    points -= [0, 1, 2, 4, 5][Math.min(gap, 4)]!;
    if (gap <= 1 && high < 10) points += 1;
  }
  return Math.max(0, Math.min(1, (points + 1) / 21));
}
