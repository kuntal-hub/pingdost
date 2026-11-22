import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seededRandom } from './random';
import { FAST_TURN_PACE, type TurnCore } from './turn';
import { TurnController } from './turn-controller';
import { turnSoloStatus } from './turn-labels';
import { createTurnSolo, normalizeTurnSoloOptions, restoreTurnSolo } from './turn-solo';
import { DOTS_AND_BOXES } from '../dots-and-boxes/rules';
import { SNAKES_AND_LADDERS } from '../snakes-and-ladders/rules';
import { TIC_TAC_TOE, type TicTacToeMove, type TicTacToeState } from '../tic-tac-toe/rules';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('solo turn games', () => {
  it('Tic-Tac-Toe against Hard: the user moves, the computer answers, the end is reported once', async () => {
    const solo = createTurnSolo(TIC_TAC_TOE, { computers: 1, level: 'hard', settings: {} }, 1);
    const saved: TurnCore[] = [];
    const over = vi.fn();
    const controller = new TurnController<TicTacToeState, TicTacToeMove, unknown>({
      rules: TIC_TAC_TOE,
      state: solo.state as TicTacToeState,
      seats: solo.seats,
      level: 'hard',
      random: seededRandom(1),
      pace: FAST_TURN_PACE,
      onState: (state) => saved.push(state),
      onOver: over,
    });
    expect(controller.getView().waiting).toBe('you');
    expect(turnSoloStatus(TIC_TAC_TOE, controller.getView())).toBe('Your turn');
    for (let i = 0; i < 20 && controller.getView().waiting !== 'over'; i++) {
      const view = controller.getView();
      if (view.waiting === 'you') controller.move(view.legal[0]!);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const view = controller.getView();
    expect(view.waiting).toBe('over');
    expect(over).toHaveBeenCalledTimes(1);
    // Playing the first free square every time loses to Hard.
    expect(over.mock.calls[0]![0]).toBe(2);
    expect(turnSoloStatus(TIC_TAC_TOE, view)).toBe('You lost');
    expect(saved[saved.length - 1]).toEqual(view.state);
    controller.dispose();
  });

  it('refuses moves out of turn and illegal moves', () => {
    const solo = createTurnSolo(TIC_TAC_TOE, { computers: 1, level: 'easy', settings: {} }, 1, 1);
    const controller = new TurnController({
      rules: TIC_TAC_TOE,
      state: solo.state as TicTacToeState,
      seats: solo.seats,
      level: 'easy',
      random: seededRandom(2),
    });
    expect(controller.getView().waiting).toBe('them');
    controller.move({ cell: 0 });
    expect(controller.getView().state.cells[0]).toBe(-1);
    controller.dispose();
  });

  it('Snakes and Ladders: everyone only rolls, to the end', async () => {
    const solo = createTurnSolo(
      SNAKES_AND_LADDERS,
      { computers: 3, level: 'medium', settings: {} },
      1,
    );
    const controller = new TurnController({
      rules: SNAKES_AND_LADDERS,
      state: solo.state as never,
      seats: solo.seats,
      level: 'medium',
      random: seededRandom(3),
      pace: FAST_TURN_PACE,
    });
    for (let i = 0; i < 5_000 && controller.getView().waiting !== 'over'; i++) {
      if (controller.getView().waiting === 'you') controller.roll();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(controller.getView().waiting).toBe('over');
    expect(controller.getView().last?.kind).toBe('roll');
    controller.dispose();
  });

  it('saves and restores solo games; options stay in range', () => {
    const solo = createTurnSolo(
      DOTS_AND_BOXES,
      { computers: 9, level: 'hard', settings: { size: 6 } },
      5,
    );
    expect(solo.seats).toEqual(['you', 'computer', 'computer', 'computer']);
    expect(solo.options.settings).toEqual({ size: 6 });
    const back = restoreTurnSolo(DOTS_AND_BOXES, JSON.parse(JSON.stringify(solo)));
    expect(back).toEqual(solo);
    expect(restoreTurnSolo(TIC_TAC_TOE, JSON.parse(JSON.stringify(solo)))).toBeNull();
    expect(normalizeTurnSoloOptions(TIC_TAC_TOE, { computers: 3, level: 'x' })).toEqual({
      computers: 1,
      level: 'medium',
      settings: {},
    });
  });
});
