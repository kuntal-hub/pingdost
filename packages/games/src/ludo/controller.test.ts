import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { YARD } from './board';
import { chooseLudoToken } from './bot';
import { FAST_PACE, LudoController } from './controller';
import type { LudoState } from './rules';
import { createLudoSolo, DEFAULT_LUDO_SOLO, restoreLudoSolo } from './solo';
import { seededRandom } from '../core/random';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Runs a game, playing the user's seat with a computer player, until it ends. */
function finish(controller: LudoController): void {
  const helper = seededRandom(5);
  for (let step = 0; step < 20_000; step++) {
    const view = controller.getView();
    if (view.waiting === 'over') return;
    if (view.waiting === 'you-roll') controller.roll();
    else if (view.waiting === 'you-move') {
      controller.move(chooseLudoToken(view.state, 'medium', helper));
    } else vi.advanceTimersByTime(100);
  }
  throw new Error('the game did not end');
}

describe('LudoController', () => {
  it('plays a whole solo game: the user, the computer players, the end', () => {
    const solo = createLudoSolo({ ...DEFAULT_LUDO_SOLO, computers: 3, level: 'hard' }, 0);
    const saved: LudoState[] = [];
    const over = vi.fn();
    const controller = new LudoController({
      state: solo.state,
      seats: solo.seats,
      level: 'hard',
      random: seededRandom(42),
      pace: FAST_PACE,
      onState: (state) => saved.push(state),
      onOver: over,
    });
    expect(controller.getView().waiting).toBe('you-roll');
    finish(controller);
    expect(over).toHaveBeenCalledTimes(1);
    expect(over.mock.calls[0]![0]).toBeGreaterThanOrEqual(1);
    expect(saved.at(-1)!.phase).toBe('over');
    controller.dispose();
  });

  it('ignores taps that are not the user’s turn and pieces that cannot move', () => {
    const solo = createLudoSolo({ ...DEFAULT_LUDO_SOLO, computers: 1 }, 0);
    const controller = new LudoController({
      state: solo.state,
      seats: solo.seats,
      level: 'easy',
      random: seededRandom(1),
      pace: FAST_PACE,
    });
    controller.move(0);
    expect(controller.getView().state).toBe(solo.state);
    controller.roll();
    controller.roll();
    expect(controller.getView().waiting).toBe('rolling');
    controller.dispose();
  });

  it('moves the only possible piece by itself when asked', () => {
    const solo = createLudoSolo({ ...DEFAULT_LUDO_SOLO, computers: 1 }, 0);
    const state: LudoState = {
      ...solo.state,
      players: solo.state.players.map((p, i) => ({
        ...p,
        tokens: i === 0 ? [10, YARD, YARD, YARD] : p.tokens,
      })),
    };
    const controller = new LudoController({
      state,
      seats: solo.seats,
      level: 'easy',
      // The first die from this seed is not a 6, so only the piece on the track can move.
      random: { next: () => 0, int: () => 0, die: () => 3 },
      pace: FAST_PACE,
      autoMove: true,
    });
    controller.roll();
    vi.advanceTimersByTime(FAST_PACE.roll + FAST_PACE.read + 10);
    expect(controller.getView().lastMove?.to).toBe(13);
    controller.dispose();
  });

  it('resumes a saved game in the middle of the user’s move', () => {
    const solo = createLudoSolo({ ...DEFAULT_LUDO_SOLO, computers: 2 }, 0);
    const mid: LudoState = { ...solo.state, phase: 'move', die: 6 };
    const restored = restoreLudoSolo(JSON.parse(JSON.stringify({ ...solo, state: mid })));
    expect(restored).not.toBeNull();
    const controller = new LudoController({
      state: restored!.state,
      seats: restored!.seats,
      level: 'medium',
      random: seededRandom(3),
      pace: FAST_PACE,
    });
    expect(controller.getView().waiting).toBe('you-move');
    expect(controller.getView().movable).toEqual([0, 1, 2, 3]);
    controller.dispose();
  });
});

describe('solo games', () => {
  it('seats the user and the chosen number of computer players; the user starts', () => {
    const solo = createLudoSolo({ ...DEFAULT_LUDO_SOLO, you: 'blue', computers: 1 }, 5);
    expect(solo.state.players.map((p) => p.color)).toEqual(['green', 'blue']);
    expect(solo.seats).toEqual(['computer', 'you']);
    expect(solo.state.current).toBe(1);
  });

  it('refuses saved data that is not a playable game', () => {
    const solo = createLudoSolo(DEFAULT_LUDO_SOLO, 0);
    expect(restoreLudoSolo(null)).toBeNull();
    expect(restoreLudoSolo({ ...solo, version: 2 })).toBeNull();
    expect(
      restoreLudoSolo({ ...solo, seats: ['computer', 'computer', 'computer', 'computer'] }),
    ).toBeNull();
    // A two-piece game saved before ADR 0050 (always four pieces) is dropped.
    const twoPieces = {
      ...solo,
      state: {
        ...solo.state,
        players: solo.state.players.map((p) => ({ ...p, tokens: [-1, -1] })),
      },
    };
    expect(restoreLudoSolo(twoPieces)).toBeNull();
    const broken = {
      ...solo,
      state: { ...solo.state, players: [{ ...solo.state.players[0], tokens: [99] }] },
    };
    expect(restoreLudoSolo(broken)).toBeNull();
    expect(restoreLudoSolo(JSON.parse(JSON.stringify(solo)))).toEqual(solo);
  });
});
