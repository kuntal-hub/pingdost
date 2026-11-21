import { describe, expect, it } from 'vitest';

import { HOME, LUDO_COLORS, YARD, type LudoColor } from './board';
import { chooseLudoToken } from './bot';
import {
  DEFAULT_LUDO_SETTINGS,
  legalTokens,
  move,
  roll,
  setupLudo,
  standings,
  type LudoSettings,
  type LudoState,
} from './rules';
import { seededRandom, type Random } from '../core/random';
import type { BotLevel } from '../core/types';

/** Plays one game between computer players; returns the final state and the turn count. */
function playOut(
  colors: LudoColor[],
  levels: BotLevel[],
  seed: number,
  settings: LudoSettings = DEFAULT_LUDO_SETTINGS,
  first: LudoColor = colors[0]!,
): { state: LudoState; rolls: number } {
  const dice: Random = seededRandom(seed);
  const choices: Random = seededRandom(seed ^ 0x5bd1e995);
  let state = setupLudo(colors, settings, first);
  const levelOf = new Map(colors.map((color, i) => [color, levels[i]!]));
  let rolls = 0;
  while (state.phase !== 'over') {
    if (++rolls > 5000) throw new Error(`game ${seed} did not end`);
    const rolled = roll(state, dice.die());
    state = rolled.state;
    if (rolled.outcome !== 'move') continue;
    const level = levelOf.get(state.players[state.current]!.color)!;
    const token = chooseLudoToken(state, level, choices);
    expect(legalTokens(state)).toContain(token);
    state = move(state, token).state;
  }
  return { state, rolls };
}

function winner(state: LudoState): LudoColor {
  return standings(state)[0]!.color;
}

describe('ludo computer players', () => {
  it('finish 1,000 games of every size, level and rule set with legal moves only', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      // Hard looks a roll ahead and is slower: it plays every tenth game.
      const levels: BotLevel[] = seed % 10 === 0 ? ['hard', 'easy', 'medium'] : ['easy', 'medium'];
      const count = 2 + (seed % 3);
      const colors = LUDO_COLORS.slice(0, count);
      const settings: LudoSettings = {
        tokens: seed % 5 === 0 ? 2 : 4,
        needSix: seed % 7 !== 0,
        blockades: seed % 4 === 0,
        stopAtFirstWinner: seed % 6 === 0,
      };
      const { state } = playOut(
        [...colors],
        colors.map((_, i) => levels[(seed + i) % levels.length]!),
        seed,
        settings,
      );
      const ranks = state.players.map((p) => p.rank).sort();
      expect(ranks).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    }
  }, 60_000);

  it('take a capture or a finish when one is there', () => {
    const base = setupLudo(['red', 'green'], DEFAULT_LUDO_SETTINGS);
    const capture: LudoState = {
      ...base,
      players: [
        { ...base.players[0]!, tokens: [10, 30, YARD, YARD] },
        { ...base.players[1]!, tokens: [1, YARD, YARD, YARD] },
      ],
    };
    const finish: LudoState = {
      ...base,
      players: [
        { ...base.players[0]!, tokens: [52, 20, YARD, YARD] },
        { ...base.players[1]!, tokens: [YARD, YARD, YARD, YARD] },
      ],
    };
    for (const level of ['medium', 'hard'] as const) {
      expect(chooseLudoToken(roll(capture, 4).state, level, seededRandom(1)), level).toBe(0);
      expect(chooseLudoToken(roll(finish, 4).state, level, seededRandom(1)), level).toBe(0);
    }
    expect(finish.players[0]!.tokens[0]! + 4).toBe(HOME);
  });

  // Ludo is mostly luck, so the margins are modest. Measured 2026-11-21: 0.84, 0.92, 0.65;
  // the seeds are fixed, so the result is stable.
  it.each([
    ['medium', 'easy', 0.75],
    ['hard', 'easy', 0.82],
    ['hard', 'medium', 0.58],
  ] as const)(
    '%s beats %s',
    (strong, weak, minimum) => {
      const games = 400;
      let wins = 0;
      for (let seed = 1; seed <= games; seed++) {
        // Alternate colors and who starts, so neither side keeps an edge.
        const strongColor: LudoColor = seed % 2 === 0 ? 'red' : 'yellow';
        const weakColor: LudoColor = strongColor === 'red' ? 'yellow' : 'red';
        const first = seed % 4 < 2 ? strongColor : weakColor;
        const { state } = playOut(
          [strongColor, weakColor],
          [strong, weak],
          seed * 7919,
          DEFAULT_LUDO_SETTINGS,
          first,
        );
        if (winner(state) === strongColor) wins++;
      }
      expect(wins / games).toBeGreaterThanOrEqual(minimum);
    },
    60_000,
  );

  it('decide quickly', () => {
    const { state } = playOut(
      ['red', 'green', 'yellow', 'blue'],
      ['hard', 'hard', 'hard', 'hard'],
      99,
    );
    expect(state.phase).toBe('over');
    const busy = setupLudo(['red', 'green', 'yellow', 'blue']);
    const crowded: LudoState = {
      ...busy,
      players: busy.players.map((p, i) => ({ ...p, tokens: [3 + i, 9 + i, 20 + i, 33 + i] })),
    };
    const ready = roll(crowded, 5).state;
    const started = performance.now();
    for (let i = 0; i < 200; i++) chooseLudoToken(ready, 'hard', seededRandom(i));
    expect((performance.now() - started) / 200).toBeLessThan(30);
  });
});
