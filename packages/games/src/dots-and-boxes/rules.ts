// Dots and Boxes (Phase 43): 2 to 4 players draw lines between dots; closing a box scores it
// and draws again. Computer players count chains: Easy slips, Medium takes every box and never
// gives one away while it has a safe line, and Hard also fights for the last safe line (a small
// search) and keeps control of long chains by double-dealing (leaving the last two boxes).
import { GameType } from '@pingdost/protocol';

import type { Random } from '../core/random';
import {
  intArray,
  leaveSeat,
  nextActive,
  passTurn,
  placesByScore,
  restoreCore,
  turnCore,
  type TurnCore,
  type TurnRules,
} from '../core/turn';
import type { BotLevel } from '../core/types';

export const DOTS_SIZES = [3, 4, 5, 6] as const;

/** Seat colors, in seat order (the four game colors). */
export const DOTS_COLORS = ['red', 'blue', 'green', 'yellow'] as const;
export const DOTS_COLOR_NAMES = ['Red', 'Blue', 'Green', 'Yellow'] as const;
export type DotsSize = (typeof DOTS_SIZES)[number];

export interface DotsSettings {
  /** Boxes per side. */
  size: DotsSize;
}

export interface DotsState extends TurnCore {
  /** −1 not drawn, else the seat that drew it (see `dotsGeometry` for the order). */
  lines: number[];
  /** Row by row: −1 open, else the seat that closed it. */
  boxes: number[];
  scores: number[];
  settings: DotsSettings;
}

export interface DotsMove {
  line: number;
}

export interface DotsGeometry {
  size: number;
  /** Horizontal lines come first: `size + 1` rows of `size`. Then `size` rows of `size + 1`. */
  horizontal: number;
  lineCount: number;
  boxCount: number;
  /** Each box's four lines: top, bottom, left, right. */
  boxLines: readonly (readonly [number, number, number, number])[];
  /** Each line's one or two boxes. */
  lineBoxes: readonly (readonly number[])[];
}

const geometries = new Map<number, DotsGeometry>();

export function dotsGeometry(size: number): DotsGeometry {
  const known = geometries.get(size);
  if (known) return known;
  const horizontal = size * (size + 1);
  const lineCount = 2 * horizontal;
  const boxLines: [number, number, number, number][] = [];
  const lineBoxes: number[][] = Array.from({ length: lineCount }, () => []);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const box = r * size + c;
      const lines: [number, number, number, number] = [
        r * size + c,
        (r + 1) * size + c,
        horizontal + r * (size + 1) + c,
        horizontal + r * (size + 1) + c + 1,
      ];
      boxLines.push(lines);
      for (const line of lines) lineBoxes[line]!.push(box);
    }
  }
  const geometry = { size, horizontal, lineCount, boxCount: size * size, boxLines, lineBoxes };
  geometries.set(size, geometry);
  return geometry;
}

/** Where a line sits: a horizontal line from dot (row, col) to the right, or a vertical one down. */
export function dotsLineAt(
  size: number,
  line: number,
): { horizontal: boolean; row: number; col: number } {
  const horizontal = size * (size + 1);
  if (line < horizontal)
    return { horizontal: true, row: Math.floor(line / size), col: line % size };
  const v = line - horizontal;
  return { horizontal: false, row: Math.floor(v / (size + 1)), col: v % (size + 1) };
}

export function normalizeDotsSettings(raw: unknown): DotsSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const size = DOTS_SIZES.includes(value.size as DotsSize) ? (value.size as DotsSize) : 4;
  return { size };
}

function setup(seats: number, settings: DotsSettings, first: number): DotsState {
  const geo = dotsGeometry(settings.size);
  return {
    ...turnCore(seats, first),
    lines: Array.from({ length: geo.lineCount }, () => -1),
    boxes: Array.from({ length: geo.boxCount }, () => -1),
    scores: Array.from({ length: seats }, () => 0),
    settings,
  };
}

function isLegal(state: DotsState, move: DotsMove): boolean {
  return (
    !state.ranks &&
    Number.isInteger(move.line) &&
    move.line >= 0 &&
    move.line < state.lines.length &&
    state.lines[move.line] === -1
  );
}

function legal(state: DotsState): DotsMove[] {
  if (state.ranks) return [];
  return state.lines.flatMap((v, line) => (v < 0 ? [{ line }] : []));
}

function apply(state: DotsState, move: DotsMove): DotsState {
  if (!isLegal(state, move)) return state;
  const geo = dotsGeometry(state.settings.size);
  const lines = [...state.lines];
  lines[move.line] = state.current;
  const boxes = [...state.boxes];
  let closed = 0;
  for (const box of geo.lineBoxes[move.line]!) {
    if (geo.boxLines[box]!.every((l) => lines[l]! >= 0)) {
      boxes[box] = state.current;
      closed++;
    }
  }
  const scores = [...state.scores];
  scores[state.current]! += closed;
  const next: DotsState = { ...state, lines, boxes, scores, turns: state.turns + 1 };
  if (boxes.every((b) => b >= 0)) return { ...next, ranks: placesByScore(next, scores) };
  return closed > 0 ? next : { ...next, current: nextActive(state.left, state.current) };
}

// Computer players: they work on a copy of the drawn lines (1 drawn, 0 not).

type Drawn = Uint8Array;

function drawnOf(state: DotsState): Drawn {
  return Uint8Array.from(state.lines, (v) => (v >= 0 ? 1 : 0));
}

function sides(drawn: Drawn, geo: DotsGeometry, box: number): number {
  let n = 0;
  for (const line of geo.boxLines[box]!) n += drawn[line]!;
  return n;
}

/** Drawing it closes a box. */
function closes(drawn: Drawn, geo: DotsGeometry, line: number): boolean {
  return geo.lineBoxes[line]!.some((box) => sides(drawn, geo, box) === 3);
}

/** Drawing it closes nothing and gives nobody a box (no box gets its third side). */
function safe(drawn: Drawn, geo: DotsGeometry, line: number): boolean {
  return geo.lineBoxes[line]!.every((box) => sides(drawn, geo, box) < 2);
}

function open(drawn: Drawn): number[] {
  const out: number[] = [];
  for (let i = 0; i < drawn.length; i++) if (!drawn[i]) out.push(i);
  return out;
}

/** Boxes the next player takes after `line` is drawn, if they take every box they can. */
function giveaway(drawn: Drawn, geo: DotsGeometry, line: number): number {
  const copy = drawn.slice();
  copy[line] = 1;
  let taken = 0;
  for (;;) {
    const next = open(copy).find((l) => closes(copy, geo, l));
    if (next === undefined) return taken;
    for (const box of geo.lineBoxes[next]!) if (sides(copy, geo, box) === 3) taken++;
    copy[next] = 1;
  }
}

/** Three-sided boxes after `line` is drawn (more means the handout cannot be declined). */
function threeSided(drawn: Drawn, geo: DotsGeometry, line: number): number {
  const copy = drawn.slice();
  copy[line] = 1;
  let n = 0;
  for (let box = 0; box < geo.boxCount; box++) if (sides(copy, geo, box) === 3) n++;
  return n;
}

function cheapest(drawn: Drawn, geo: DotsGeometry, lines: number[], careful: boolean): number[] {
  let best = Infinity;
  let out: number[] = [];
  for (const line of lines) {
    // Hard prefers handouts that can't be declined (more three-sided boxes) at equal cost.
    const cost = giveaway(drawn, geo, line) * 10 - (careful ? threeSided(drawn, geo, line) : 0);
    if (cost < best) {
      best = cost;
      out = [line];
    } else if (cost === best) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Whether the player to move wins the fight for the last safe line (the other must then open a
 * chain), or null when the search grows too big.
 */
function lastSafeWins(
  drawn: Drawn,
  geo: DotsGeometry,
  memo: Map<string, boolean>,
  budget: { nodes: number },
): boolean | null {
  const key = drawn.join('');
  const known = memo.get(key);
  if (known !== undefined) return known;
  if (--budget.nodes < 0) return null;
  let win = false;
  for (const line of open(drawn)) {
    if (!safe(drawn, geo, line)) continue;
    drawn[line] = 1;
    const reply = lastSafeWins(drawn, geo, memo, budget);
    drawn[line] = 0;
    if (reply === null) return null;
    if (!reply) {
      win = true;
      break;
    }
  }
  memo.set(key, win);
  return win;
}

/**
 * The double-deal: with one box left to take before the last two of a chain and no safe line
 * anywhere, draw the far side of the next box instead, so the other player takes the two boxes
 * and must open the next chain. Returns that line, or null.
 */
function doubleDeal(drawn: Drawn, geo: DotsGeometry, boxes: readonly number[]): number | null {
  const lines = open(drawn);
  if (lines.some((line) => safe(drawn, geo, line))) return null;
  const capturable: number[] = [];
  for (let box = 0; box < geo.boxCount; box++) {
    if (boxes[box]! < 0 && sides(drawn, geo, box) === 3) capturable.push(box);
  }
  if (capturable.length !== 1) return null;
  const a = capturable[0]!;
  const last = geo.boxLines[a]!.find((line) => !drawn[line])!;
  const b = geo.lineBoxes[last]!.find((box) => box !== a);
  if (b === undefined || sides(drawn, geo, b) !== 2) return null;
  const far = geo.boxLines[b]!.find((line) => line !== last && !drawn[line]);
  if (far === undefined) return null;
  const beyond = geo.lineBoxes[far]!.find((box) => box !== b);
  if (beyond !== undefined && sides(drawn, geo, beyond) >= 2) return null;
  // Worth two boxes only if a long chain or loop is still to come.
  const rest = boxes.filter((owner, box) => owner < 0 && box !== a && box !== b).length;
  return rest >= 3 ? far : null;
}

export function chooseDotsMove(state: DotsState, level: BotLevel, random: Random): DotsMove {
  const geo = dotsGeometry(state.settings.size);
  const drawn = drawnOf(state);
  const lines = open(drawn);
  const pick = (list: number[]) => ({ line: list[random.int(list.length)]! });
  if (lines.length === 0) return { line: 0 };
  const captures = lines.filter((line) => closes(drawn, geo, line));
  const safeLines = lines.filter((line) => safe(drawn, geo, line));

  if (level === 'easy') {
    if (captures.length > 0 && random.next() < 0.6) return pick(captures);
    if (safeLines.length > 0 && random.next() < 0.6) return pick(safeLines);
    return pick(lines);
  }
  if (level === 'hard' && captures.length > 0) {
    const deal = doubleDeal(drawn, geo, state.boxes);
    if (deal !== null) return { line: deal };
  }
  if (captures.length > 0) return pick(captures);
  if (safeLines.length > 0) {
    if (level === 'hard' && safeLines.length <= 16) {
      const memo = new Map<string, boolean>();
      const budget = { nodes: 40_000 };
      const winning: number[] = [];
      for (const line of safeLines) {
        drawn[line] = 1;
        const reply = lastSafeWins(drawn, geo, memo, budget);
        drawn[line] = 0;
        if (reply === null) break;
        if (!reply) winning.push(line);
      }
      if (winning.length > 0 && budget.nodes >= 0) return pick(winning);
    }
    return pick(safeLines);
  }
  return pick(cheapest(drawn, geo, lines, level === 'hard'));
}

export const DOTS_AND_BOXES: TurnRules<DotsState, DotsMove, DotsSettings> = {
  id: 'dots-and-boxes',
  wireType: GameType.DOTS_AND_BOXES,
  minPlayers: 2,
  maxPlayers: 4,
  dice: false,
  levels: true,
  turnMs: 30_000,
  defaultSettings: { size: 4 },
  normalizeSettings: normalizeDotsSettings,
  settingsToWire: (settings) => ({ case: 'dots', value: { size: settings.size } }),
  settingsFromWire: (create) =>
    normalizeDotsSettings(
      create.settings.case === 'dots' ? { size: create.settings.value.size || 4 } : {},
    ),
  setup,
  legal,
  isLegal,
  apply,
  skip: passTurn,
  leave: (state, seat) => leaveSeat(state, seat),
  bot: chooseDotsMove,
  proxy: (state, random) => chooseDotsMove(state, 'medium', random),
  moveToWire: (move) => ({ case: 'dots', value: { line: move.line } }),
  moveFromWire: (wire) => (wire.play.case === 'dots' ? { line: wire.play.value.line } : null),
  sameMove: (a, b) => a.line === b.line,
  canonical: (s) =>
    [
      s.settings.size,
      s.current,
      s.turns,
      s.lines.join(','),
      s.boxes.join(','),
      s.scores.join(','),
      s.left.map(Number).join(''),
      s.ranks?.join(',') ?? '-',
    ].join('|'),
  restore(raw) {
    const core = restoreCore(raw, 2, 4);
    if (!core) return null;
    const s = raw as Partial<DotsState>;
    const settings = normalizeDotsSettings(s.settings);
    const geo = dotsGeometry(settings.size);
    const max = core.seats - 1;
    const lines = intArray(s.lines, geo.lineCount, -1, max);
    const boxes = intArray(s.boxes, geo.boxCount, -1, max);
    const scores = intArray(s.scores, core.seats, 0, geo.boxCount);
    if (!lines || !boxes || !scores) return null;
    return { ...core, lines, boxes, scores, settings };
  },
  sideName: (_state, seat) => DOTS_COLOR_NAMES[seat] ?? `Player ${seat + 1}`,
  rulesText: (settings) => [
    `Take turns drawing one line between two dots next to each other (${settings.size} by ${settings.size} boxes).`,
    'Draw the fourth side of a box to close it: it is yours, and you draw again.',
    'When every box is closed, whoever has the most wins.',
  ],
  resultDetail: (state) =>
    state.scores.length === 2
      ? `${Math.max(...state.scores)} boxes to ${Math.min(...state.scores)}`
      : state.scores.map((s, i) => `${DOTS_COLOR_NAMES[i]} ${s}`).join(' · '),
};
