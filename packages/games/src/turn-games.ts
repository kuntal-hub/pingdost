// Every turn game by its catalog ID (Phase 43). The apps pick a game's rules from here.
import { CALL_BRIDGE } from './call-bridge/rules';
import { CHESS, type ChessState } from './chess/rules';
import { CONNECT_FOUR, connectFourColor, type ConnectFourState } from './connect-four/rules';
import type { AnyTurnRules, TurnCore, TurnGameId } from './core/turn';
import { DOTS_AND_BOXES, DOTS_COLORS } from './dots-and-boxes/rules';
import { LAST_CARD } from './last-card/rules';
import { POKER } from './poker/rules';
import { SNAKES_AND_LADDERS, SNAKES_COLORS } from './snakes-and-ladders/rules';
import { TIC_TAC_TOE, ticTacToeMark, type TicTacToeState } from './tic-tac-toe/rules';

export const TURN_GAMES: Readonly<Record<TurnGameId, AnyTurnRules>> = {
  'tic-tac-toe': TIC_TAC_TOE,
  'connect-four': CONNECT_FOUR,
  'dots-and-boxes': DOTS_AND_BOXES,
  'snakes-and-ladders': SNAKES_AND_LADDERS,
  chess: CHESS,
  'last-card': LAST_CARD,
  'call-bridge': CALL_BRIDGE,
  poker: POKER,
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
    case 'last-card':
    case 'call-bridge':
      return DOTS_COLORS[seat] ?? 'red';
    case 'snakes-and-ladders':
      return SNAKES_COLORS[seat] ?? 'red';
    case 'poker':
      // Up to six seats on four colors: the table also shows each seat's name and chips.
      return DOTS_COLORS[seat % DOTS_COLORS.length] ?? 'red';
    case 'chess':
      // Chess sides are White and Black; the apps draw a king. Blue and red only tint the strip.
      return seat === (state as ChessState).white ? 'blue' : 'red';
  }
}
