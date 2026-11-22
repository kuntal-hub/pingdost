// What the solo and friend screens of the turn games share (Phase 43): the board for each game,
// the players' strip (whose turn, scores, the timer), the die, and sounds and haptics per step.
import { useEffect, useRef, type ComponentType } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/text';
import { playGameSound } from '@/games/sounds';
import { haptic } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  isDraw,
  KING,
  snakesPath,
  turnSeatColor,
  type AnyTurnRules,
  type ChessState,
  type DotsState,
  type LastCardState,
  type SnakesState,
  type TurnCore,
  type TurnGameId,
  type TurnLast,
  type TurnPace,
  type TurnWaiting,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import type { TurnBoardProps } from './board-props';
import { ChessBoard, ChessPiece } from './chess-board';
import { ConnectFourBoard } from './connect-four-board';
import { DotsBoard } from './dots-board';
import { LastCardBoard } from './last-card-board';
import { SnakesBoard } from './snakes-board';
import { TicTacToeBoard } from './tic-tac-toe-board';
import { Dice } from '../ludo/dice';
import { ShapeGlyph } from '../shape';

// Each board takes its own game's state and moves; the screens pass the matching rules.
const BOARDS = {
  'tic-tac-toe': TicTacToeBoard,
  'connect-four': ConnectFourBoard,
  'dots-and-boxes': DotsBoard,
  'snakes-and-ladders': SnakesBoard,
  chess: ChessBoard,
  'last-card': LastCardBoard,
} as unknown as Record<TurnGameId, ComponentType<TurnBoardProps>>;

export function TurnBoard({ rules, ...props }: TurnBoardProps & { rules: AnyTurnRules }) {
  const Board = BOARDS[rules.id];
  return <Board {...props} />;
}

/** The board's width for the space there is (Snakes and Ladders needs room for its start row). */
export function turnBoardWidth(rules: AnyTurnRules, width: number, height: number): number {
  const tall =
    rules.id === 'snakes-and-ladders'
      ? 1.11
      : rules.id === 'connect-four'
        ? 0.9
        : rules.id === 'last-card'
          ? 0.75
          : 1;
  return Math.floor(Math.max(220, Math.min(width - 24, (height - 330) / tall, 520)));
}

/** A seat's score or square, if the game has one. */
function seatDetail(rules: AnyTurnRules, state: TurnCore, seat: number): string | null {
  if (rules.id === 'dots-and-boxes') {
    const score = (state as DotsState).scores[seat] ?? 0;
    return `${score} ${score === 1 ? 'box' : 'boxes'}`;
  }
  if (rules.id === 'last-card') {
    const count = (state as LastCardState).hands[seat]?.length ?? 0;
    return `${count} ${count === 1 ? 'card' : 'cards'}`;
  }
  if (rules.id === 'snakes-and-ladders') {
    const square = (state as SnakesState).positions[seat] ?? 0;
    return square === 0 ? 'Start' : `Square ${square}`;
  }
  return null;
}

export function PlayersStrip({
  rules,
  state,
  names,
  over,
  timeLeft,
}: {
  rules: AnyTurnRules;
  state: TurnCore;
  /** Each seat's name ("You", a friend's name, the computer's side). */
  names: (seat: number) => string;
  over: boolean;
  /** The open step's time left (0–1) in games with a timer. */
  timeLeft: number | null;
}) {
  const { dark } = useTheme();
  const colors = gameBoardColors(dark);
  return (
    <View className="flex-row flex-wrap justify-center gap-2 px-2">
      {Array.from({ length: state.seats }, (_, seat) => {
        const color = turnSeatColor(rules.id, state, seat);
        const look = colors.players[color];
        const active = !over && state.current === seat;
        const left = state.left[seat];
        const detail = left ? 'Left' : seatDetail(rules, state, seat);
        const side = rules.sideName(state, seat);
        return (
          <View
            key={seat}
            accessibilityLabel={`${names(seat)}, ${side}${detail ? `, ${detail}` : ''}${active ? ', playing now' : ''}`}
            className={`min-w-[132px] flex-row items-center gap-2 rounded-2xl px-3 py-2 ${active ? 'bg-surface' : ''}`}
            style={{
              opacity: left ? 0.5 : 1,
              borderWidth: 2,
              borderColor: active ? look.ring : 'transparent',
            }}
          >
            {rules.id === 'chess' ? (
              <ChessPiece piece={side === 'White' ? KING : -KING} size={30} colors={colors.chess} />
            ) : (
              <View
                className="items-center justify-center rounded-full"
                style={{
                  width: 28,
                  height: 28,
                  backgroundColor: look.fill,
                  borderWidth: 2,
                  borderColor: look.ring,
                }}
              >
                {rules.id === 'tic-tac-toe' ? (
                  <Text className="text-sm font-bold" style={{ color: look.on }}>
                    {side}
                  </Text>
                ) : (
                  <ShapeGlyph color={color} size={14} fill={look.on} />
                )}
              </View>
            )}
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-sm font-bold text-foreground">
                {names(seat)}
              </Text>
              {detail && <Text className="text-xs text-muted">{detail}</Text>}
              {active && timeLeft !== null && (
                <View className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
                  <View
                    style={{
                      width: `${Math.round(timeLeft * 100)}%`,
                      height: '100%',
                      backgroundColor: look.fill,
                    }}
                  />
                </View>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** Chess: the moves so far in SAN, the newest last (a row that scrolls). */
export function ChessMoves({ state }: { state: ChessState }) {
  if (state.san.length === 0) return null;
  const pairs: string[] = [];
  for (let i = 0; i < state.san.length; i += 2) {
    pairs.push(`${i / 2 + 1}. ${state.san[i]}${state.san[i + 1] ? `  ${state.san[i + 1]}` : ''}`);
  }
  return (
    <Text
      accessibilityLabel={`Moves: ${state.san.join(', ')}`}
      numberOfLines={1}
      ellipsizeMode="head"
      className="max-w-full px-4 text-sm text-muted"
    >
      {pairs.slice(-4).join('   ')}
    </Text>
  );
}

/** The die of a dice game: the roll button on the user's turn, in the roller's color. */
export function TurnDie({
  rules,
  state,
  waiting,
  last,
  you,
  moves,
  pace,
  onRoll,
}: {
  rules: AnyTurnRules;
  state: TurnCore;
  waiting: TurnWaiting;
  last: TurnLast<TurnCore, unknown> | null;
  you: number;
  moves: boolean;
  pace: TurnPace;
  onRoll: () => void;
}) {
  const { dark } = useTheme();
  if (!rules.dice) return null;
  const colors = gameBoardColors(dark);
  const rolling = waiting === 'rolling';
  const seat = rolling || !last ? state.current : last.seat;
  const look = colors.players[turnSeatColor(rules.id, state, seat)];
  return (
    <View className="items-center">
      <Dice
        value={last?.die ?? null}
        rolling={rolling}
        rollId={last?.id ?? 0}
        look={look}
        ready={waiting === 'you' && state.current === you}
        onRoll={onRoll}
        size={56}
        moves={moves}
        duration={pace.roll}
      />
    </View>
  );
}

interface StepView {
  state: TurnCore;
  you: number;
  waiting: TurnWaiting;
  last: TurnLast<TurnCore, unknown> | null;
}

/** Sounds per step (ADR 0050's set) and a haptic for the result; a restored game is silent. */
export function useTurnFeedback(
  rules: AnyTurnRules,
  view: StepView | null,
  pace: TurnPace,
  moves: boolean,
): void {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const seen = useRef<{ step: number; rolling: boolean; over: boolean } | null>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!view) return;
    if (!seen.current) {
      seen.current = {
        step: view.last?.id ?? 0,
        rolling: view.waiting === 'rolling',
        over: view.waiting === 'over',
      };
      return;
    }
    const at = (ms: number, kind: Parameters<typeof playGameSound>[0]) =>
      timers.current.push(setTimeout(() => playGameSound(kind), ms));
    const rolling = view.waiting === 'rolling';
    if (rolling && !seen.current.rolling) playGameSound('roll');
    seen.current.rolling = rolling;
    const last = view.last;
    if (last && last.id !== seen.current.step) {
      seen.current.step = last.id;
      if (last.kind === 'roll' && last.die !== undefined) {
        const before = last.before as SnakesState;
        const path = snakesPath(before.positions[last.seat]!, last.die, before.settings);
        const hop = moves ? pace.hop : 0;
        path.walk.forEach((_, i) => at((i + 0.85) * hop, 'hop'));
        if (path.jump)
          at(
            path.walk.length * hop + (moves ? pace.slide : 0),
            path.jump.kind === 'ladder' ? 'home' : 'capture',
          );
      } else if (last.kind === 'move' || last.kind === 'proxy') {
        const closed =
          rules.id === 'dots-and-boxes' &&
          (last.state as DotsState).scores.some(
            (s, i) => s > (last.before as DotsState).scores[i]!,
          );
        playGameSound(closed ? 'capture' : 'hop');
        if (closed && last.seat === view.you) haptic('light');
      }
    }
    if (view.waiting === 'over' && !seen.current.over) {
      seen.current.over = true;
      const place = view.you >= 0 ? view.state.ranks?.[view.you] : undefined;
      const won = place === 1 && !view.state.left[view.you] && !isDraw(view.state);
      if (won) at(400, 'win');
      if (view.you >= 0) haptic(won ? 'success' : 'warning');
    }
  }, [rules, view, pace, moves]);
}
