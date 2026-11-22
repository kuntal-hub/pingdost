// Every turn game by its catalog ID (Phase 43). The apps pick a game's rules from here.
import { CONNECT_FOUR, connectFourColor, type ConnectFourState } from './connect-four/rules';
import type { AnyTurnRules, TurnCore, TurnGameId } from './core/turn';
import { DOTS_AND_BOXES, DOTS_COLORS } from './dots-and-boxes/rules';
import { SNAKES_AND_LADDERS, SNAKES_COLORS } from './snakes-and-ladders/rules';
import { TIC_TAC_TOE, ticTacToeMark, type TicTacToeState } from './tic-tac-toe/rules';

export const TURN_GAMES: Readonly<Record<TurnGameId, AnyTurnRules>> = {
  'tic-tac-toe': TIC_TAC_TOE,
  'connect-four': CONNECT_FOUR,
  'dots-and-boxes': DOTS_AND_BOXES,
  'snakes-and-ladders': SNAKES_AND_LADDERS,
};

export const TURN_GAME_IDS = Object.keys(TURN_GAMES) as TurnGameId[];

export function turnRules(id: TurnGameId): AnyTurnRules {
  return TURN_GAMES[id];
}

export type SeatColor = 'red' | 'green' | 'yellow' | 'blue';

/**
 * The color a seat plays in (ui-tokens `gameBoardColors().players`): X red and O blue, red and
 * yellow discs, and the four colors in seat order for the games of up to four.
 */
export function turnSeatColor(id: TurnGameId, state: TurnCore, seat: number): SeatColor {
  switch (id) {
    case 'tic-tac-toe':
      return ticTacToeMark(state as TicTacToeState, seat) === 'X' ? 'red' : 'blue';
    case 'connect-four':
      return connectFourColor(state as ConnectFourState, seat);
    case 'dots-and-boxes':
      return DOTS_COLORS[seat] ?? 'red';
    case 'snakes-and-ladders':
      return SNAKES_COLORS[seat] ?? 'red';
  }
}
