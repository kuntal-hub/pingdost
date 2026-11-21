import { describe, expect, it } from 'vitest';

import { HOME, YARD, type LudoColor } from './board';
import {
  colorsFor,
  DEFAULT_LUDO_SETTINGS,
  distinctTokens,
  leave,
  legalTokens,
  LudoRuleError,
  move,
  normalizeLudoSettings,
  roll,
  setupLudo,
  standings,
  type LudoSettings,
  type LudoState,
} from './rules';

function game(
  tokens: Partial<Record<LudoColor, number[]>>,
  settings: Partial<LudoSettings> = {},
  first?: LudoColor,
): LudoState {
  const colors = Object.keys(tokens) as LudoColor[];
  const state = setupLudo(colors, { ...DEFAULT_LUDO_SETTINGS, ...settings }, first ?? colors[0]);
  return {
    ...state,
    players: state.players.map((player) => ({ ...player, tokens: [...tokens[player.color]!] })),
  };
}

const Y = YARD;

describe('setup', () => {
  it('plays clockwise whatever order the colors come in', () => {
    const state = setupLudo(['blue', 'red', 'yellow'], DEFAULT_LUDO_SETTINGS, 'yellow');
    expect(state.players.map((p) => p.color)).toEqual(['red', 'yellow', 'blue']);
    expect(state.current).toBe(1);
    expect(state.players.every((p) => p.tokens.every((t) => t === YARD))).toBe(true);
  });

  it('seats two players in opposite corners', () => {
    expect(colorsFor(2, 'green')).toEqual(['green', 'blue']);
    expect(colorsFor(3, 'red')).toEqual(['red', 'green', 'yellow']);
    expect(colorsFor(4, 'yellow')).toHaveLength(4);
  });

  it('refuses one player or a repeated color', () => {
    expect(() => setupLudo(['red'])).toThrow(LudoRuleError);
    expect(() => setupLudo(['red', 'red'])).toThrow(LudoRuleError);
  });

  it('reads stored settings, falling back to the classic ones', () => {
    expect(normalizeLudoSettings(null)).toEqual(DEFAULT_LUDO_SETTINGS);
    // A stored `tokens: 2` from before ADR 0050 is ignored: always four pieces.
    expect(normalizeLudoSettings({ tokens: 2, blockades: true, needSix: 'yes' })).toEqual({
      ...DEFAULT_LUDO_SETTINGS,
      blockades: true,
    });
  });
});

describe('leaving the yard', () => {
  it('needs a 6, and the 6 gives another roll', () => {
    let state = game({ red: [Y, Y, Y, Y], yellow: [Y, Y, Y, Y] });
    const five = roll(state, 5);
    expect(five.outcome).toBe('pass');
    expect(five.state.current).toBe(1);

    state = roll(state, 6).state;
    expect(legalTokens(state)).toEqual([0, 1, 2, 3]);
    expect(distinctTokens(state)).toEqual([0]);
    const moved = move(state, 2);
    expect(moved.to).toBe(0);
    expect(moved.again).toBe(true);
    expect(moved.state.current).toBe(0);
    expect(moved.state.phase).toBe('roll');
  });

  it('leaves on any roll when the toggle is off, to the start square', () => {
    const state = roll(
      game({ red: [Y, Y, Y, Y], yellow: [Y, Y, Y, Y] }, { needSix: false }),
      3,
    ).state;
    const moved = move(state, 0);
    expect(moved.to).toBe(0);
    expect(moved.again).toBe(false);
    expect(moved.state.current).toBe(1);
  });
});

describe('turns', () => {
  it('passes the turn on a third 6 in a row without moving', () => {
    let state = game({ red: [10, Y, Y, Y], yellow: [Y, Y, Y, Y] });
    state = move(roll(state, 6).state, 0).state;
    state = move(roll(state, 6).state, 0).state;
    expect(state.sixes).toBe(2);
    const third = roll(state, 6);
    expect(third.outcome).toBe('third-six');
    expect(third.state.current).toBe(1);
    expect(third.state.players[0]!.tokens[0]).toBe(22);
    expect(third.state.sixes).toBe(0);
  });

  it('passes when no piece can move', () => {
    const result = roll(game({ red: [54, Y, Y, Y], yellow: [Y, Y, Y, Y] }), 4);
    expect(result.outcome).toBe('pass');
    expect(result.state.turns).toBe(1);
  });

  it('counts turns, not rolls', () => {
    let state = game({ red: [5, Y, Y, Y], yellow: [5, Y, Y, Y] });
    state = move(roll(state, 6).state, 0).state;
    state = move(roll(state, 2).state, 0).state;
    expect(state.turns).toBe(1);
    expect(state.current).toBe(1);
  });
});

describe('captures and safe squares', () => {
  it('sends a piece home and gives another roll', () => {
    // Red at track 10; green's piece at progress 1 stands on track 14.
    const state = roll(game({ red: [10, Y, Y, Y], green: [1, Y, Y, Y] }), 4).state;
    const result = move(state, 0);
    expect(result.captures).toEqual([{ seat: 1, token: 0, from: 1 }]);
    expect(result.state.players[1]!.tokens[0]).toBe(YARD);
    expect(result.again).toBe(true);
  });

  it('captures every piece of another color on the square', () => {
    const state = roll(game({ red: [10, Y, Y, Y], green: [1, 1, Y, Y] }), 4).state;
    expect(move(state, 0).captures).toHaveLength(2);
  });

  it('never captures on a start square or a star', () => {
    // Green's start (track 13) and the star at track 8 (green progress 47).
    let state = roll(game({ red: [9, 5, Y, Y], green: [0, 47, Y, Y] }), 4).state;
    let result = move(state, 0);
    expect(result.captures).toEqual([]);
    expect(result.again).toBe(false);
    state = { ...result.state, current: 0, phase: 'roll' };
    result = move(roll(state, 3).state, 1);
    expect(result.captures).toEqual([]);
    expect(result.state.players[1]!.tokens).toEqual([0, 47, Y, Y]);
  });

  it('leaves own pieces alone', () => {
    const state = roll(game({ red: [10, 14, Y, Y], green: [Y, Y, Y, Y] }), 4).state;
    expect(move(state, 0).captures).toEqual([]);
  });
});

describe('home', () => {
  it('needs the exact roll and gives another roll', () => {
    let state = roll(game({ red: [53, 20, Y, Y], yellow: [Y, Y, Y, Y] }), 4).state;
    expect(legalTokens(state)).toEqual([1]);
    state = roll(game({ red: [53, 20, Y, Y], yellow: [Y, Y, Y, Y] }), 3).state;
    const result = move(state, 0);
    expect(result.to).toBe(HOME);
    expect(result.home).toBe(true);
    expect(result.again).toBe(true);
  });

  it('ranks a finished player and plays on for places', () => {
    const state = roll(
      game({ red: [HOME, HOME, HOME, 55], green: [3, Y, Y, Y], yellow: [7, Y, Y, Y] }),
      1,
    ).state;
    const result = move(state, 3);
    expect(result.again).toBe(false);
    expect(result.state.players[0]!.rank).toBe(1);
    expect(result.state.phase).toBe('roll');
    expect(result.state.current).toBe(1);
  });

  it('ends at the first winner when set, ranking the rest by progress', () => {
    const state = roll(
      game(
        { red: [HOME, HOME, HOME, 55], green: [3, Y, Y, Y], yellow: [7, Y, Y, Y] },
        { stopAtFirstWinner: true },
      ),
      1,
    ).state;
    const result = move(state, 3);
    expect(result.state.phase).toBe('over');
    expect(standings(result.state).map((s) => s.color)).toEqual(['red', 'yellow', 'green']);
  });

  it('ends when only one player is still playing', () => {
    const state = roll(game({ red: [HOME, HOME, HOME, 55], blue: [3, Y, Y, Y] }), 1).state;
    const result = move(state, 3);
    expect(result.state.phase).toBe('over');
    expect(result.state.players.map((p) => p.rank)).toEqual([1, 2]);
  });
});

describe('blockades', () => {
  const walled = { red: [12, 12, 10, Y], green: [1, 1, Y, Y] };

  it('stops others from passing or landing on two pieces of one color', () => {
    // Green's two pieces stand on track 14.
    const state = roll(game({ ...walled, red: [12, Y, Y, Y] }, { blockades: true }), 3).state;
    expect(legalTokens(state)).toEqual([]);
    const short = roll(game({ ...walled, red: [12, Y, Y, Y] }, { blockades: true }), 1).state;
    expect(legalTokens(short)).toEqual([0]);
  });

  it('lets a player pass their own wall', () => {
    const state = roll(
      game({ red: [12, 12, 10, Y], green: [Y, Y, Y, Y] }, { blockades: true }),
      4,
    ).state;
    expect(legalTokens(state)).toContain(2);
  });

  it('is off by default: a pair can be passed and captured', () => {
    const state = roll(game({ red: [12, Y, Y, Y], green: [1, 1, Y, Y] }), 2).state;
    expect(move(state, 0).captures).toHaveLength(2);
  });
});

describe('pieces and leaving', () => {
  it('always gives every player four pieces', () => {
    const state = setupLudo(['red', 'blue'], normalizeLudoSettings({ tokens: 2 }));
    expect(state.players.map((p) => p.tokens)).toEqual([
      [Y, Y, Y, Y],
      [Y, Y, Y, Y],
    ]);
  });

  it('takes a leaving player off the board and skips them', () => {
    let state = game({ red: [5, Y, Y, Y], green: [9, Y, Y, Y], yellow: [Y, Y, Y, Y] });
    state = leave(state, 1);
    expect(state.players[1]!.left).toBe(true);
    expect(state.players[1]!.tokens).toEqual([Y, Y, Y, Y]);
    state = roll(state, 2).state;
    state = move(state, 0).state;
    expect(state.current).toBe(2);
  });

  it('ends the game when the second-to-last player leaves', () => {
    const state = leave(game({ red: [5, Y, Y, Y], green: [9, Y, Y, Y] }), 0);
    expect(state.phase).toBe('over');
    expect(standings(state)[0]!.color).toBe('green');
  });

  it('refuses moves out of turn', () => {
    const state = game({ red: [5, Y, Y, Y], green: [9, Y, Y, Y] });
    expect(() => move(state, 0)).toThrow(LudoRuleError);
    expect(() => roll(roll(state, 2).state, 3)).toThrow(LudoRuleError);
    expect(() => move(roll(state, 2).state, 1)).toThrow(LudoRuleError);
  });
});
