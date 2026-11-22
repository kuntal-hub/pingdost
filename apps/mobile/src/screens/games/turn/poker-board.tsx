// Poker on the phone (Phase 47): the table (the pot, the five shared cards, how the last hand
// ended), the hands shown at the showdown, the user's two cards with what they make, and the
// betting bar (fold, check or call, and a raise with an amount). Everyone's chips, bets and
// folds are in the players' strip above. Play chips only.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { CSS_POP } from '@/theme/motion';
import {
  bridgeCardName,
  buildPots,
  formatChips,
  handName,
  handScore,
  liveSeats,
  pokerResultLine,
  potTotal,
  raiseRange,
  toCall,
  type PokerMove,
  type PokerResult,
  type PokerState,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { POP_IN, type TurnBoardProps } from './board-props';
import { PlayingCard } from './call-bridge-board';

/** The result the table shows between hands (null while a hand is played). */
export function pokerShownResult(state: PokerState): PokerResult | null {
  if (state.phase === 'reveal') return state.last;
  if (state.phase === 'deal' && state.last && state.last.hand === state.hand - 1) return state.last;
  if (state.phase === 'done') return state.last;
  return null;
}

export function PokerBoard({
  state,
  you,
  legal,
  onMove,
  size,
  dark,
  moves,
  pace,
  last,
  names,
}: TurnBoardProps<PokerState, PokerMove>) {
  const { felt } = gameBoardColors(dark);
  const name = (seat: number) => names?.(seat) ?? (seat === you ? 'You' : `Seat ${seat + 1}`);
  const result = pokerShownResult(state);
  const board = result ? result.board : state.board;
  const pot = potTotal(state);
  const pots = pot > 0 ? buildPots(state.contrib, liveSeats(state)) : [];
  const card = Math.min(54, Math.floor((size - 48) / 5.6));
  const freshBoard = last ? last.state.board.length > last.before.board.length : false;
  const showdown = result
    ? result.shown.flatMap((cards, seat) =>
        cards ? [{ seat, cards, score: result.scores[seat] ?? null }] : [],
      )
    : state.phase === 'show' || state.phase === 'board'
      ? state.shown.flatMap((shown, seat) =>
          shown ? [{ seat, cards: state.holes[seat]!, score: null as number | null }] : [],
        )
      : [];
  const mine = you >= 0 ? (state.holes[you] ?? []) : [];
  const known = mine.length === 2 && mine[0]! >= 0;
  const folded = you >= 0 && state.dealt[you] && state.folded[you];
  const made =
    known && state.board.length >= 3 && !result
      ? handName(handScore([...mine, ...state.board]))
      : null;

  return (
    <View style={{ width: size, gap: 10, alignItems: 'center' }}>
      <View
        style={{
          width: size,
          minHeight: size * 0.5,
          borderRadius: size * 0.2,
          backgroundColor: felt.cloth,
          borderWidth: 6,
          borderColor: felt.rim,
          paddingVertical: 12,
          paddingHorizontal: 14,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <Text style={{ color: felt.ink }} className="text-xs font-bold">
          Hand {state.hand + 1} · Blinds {formatChips(state.sb)}/{formatChips(state.bb)}
        </Text>
        <Text
          accessibilityLabel={`Pot ${formatChips(pot)} chips`}
          style={{ color: felt.ink }}
          className="text-base font-bold"
        >
          {pot > 0 ? `Pot ${formatChips(pot)}` : ' '}
          {pots.length > 1 &&
            ` · ${pots.map((p, i) => `${i === 0 ? 'main' : 'side'} ${formatChips(p.amount)}`).join(' · ')}`}
        </Text>
        <View
          className="flex-row gap-1.5"
          accessibilityLabel={
            board.length > 0
              ? `On the table: ${board.map(bridgeCardName).join(', ')}`
              : 'No shared cards yet'
          }
        >
          {Array.from({ length: 5 }, (_, i) => {
            const value = board[i];
            if (value === undefined) {
              return (
                <View
                  key={i}
                  style={{
                    width: card,
                    height: Math.round(card * 1.42),
                    borderRadius: card * 0.12,
                    borderWidth: 2,
                    borderStyle: 'dashed',
                    borderColor: felt.slot,
                  }}
                />
              );
            }
            const fresh = freshBoard && moves && i >= (last?.before.board.length ?? 5);
            return (
              <Animated.View
                key={`${state.hand}-${i}-${fresh ? last?.id : 'still'}`}
                style={
                  fresh
                    ? {
                        animationName: POP_IN,
                        animationDuration: pace.step * 2,
                        animationTimingFunction: CSS_POP,
                      }
                    : undefined
                }
              >
                <PlayingCard card={value} width={card} dark={dark} />
              </Animated.View>
            );
          })}
        </View>
        {result && (
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: felt.ink }}
            className="text-center text-sm font-bold"
          >
            {pokerResultLine(result, name)}
          </Text>
        )}
      </View>

      {showdown.length > 0 && (
        <View className="w-full gap-1.5 px-1">
          {showdown.map(({ seat, cards, score }) => {
            const winner = result ? result.won[seat]! > 0 : false;
            return (
              <View
                key={seat}
                accessibilityLabel={`${name(seat)}: ${cards.map(bridgeCardName).join(' and ')}${score !== null ? `, ${handName(score)}` : ''}${winner ? ', wins' : ''}`}
                className={`flex-row items-center gap-2 rounded-2xl px-3 py-1.5 ${winner ? 'bg-surface' : ''}`}
              >
                <Text numberOfLines={1} className="w-24 text-sm font-bold text-foreground">
                  {name(seat)}
                </Text>
                {cards.map((c) => (
                  <PlayingCard key={c} card={c} width={30} dark={dark} />
                ))}
                <Text numberOfLines={1} className="flex-1 text-sm text-muted">
                  {score !== null ? handName(score) : ''}
                  {winner ? ` · +${formatChips(result!.won[seat]!)}` : ''}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {you >= 0 && state.dealt[you] && !result && (
        <View className="items-center gap-1">
          <View
            className="flex-row gap-2"
            accessibilityLabel={
              known
                ? `Your cards: ${mine.map(bridgeCardName).join(' and ')}`
                : 'Your cards are on the way'
            }
            style={{ opacity: folded ? 0.45 : 1 }}
          >
            {(mine.length === 2 ? mine : [-1, -1]).map((c, i) => (
              <PlayingCard key={i} card={c} width={Math.min(64, card * 1.2)} dark={dark} />
            ))}
          </View>
          <Text className="text-sm font-bold text-muted">
            {folded ? 'You folded' : (made ?? (known ? ' ' : 'Waiting for your cards…'))}
          </Text>
        </View>
      )}

      {legal.length > 0 && <BettingBar state={state} legal={legal} onMove={onMove} width={size} />}
    </View>
  );
}

function BettingBar({
  state,
  legal,
  onMove,
  width,
}: {
  state: PokerState;
  legal: readonly PokerMove[];
  onMove: (move: PokerMove) => void;
  width: number;
}) {
  const range = raiseRange(state);
  const [raising, setRaising] = useState(false);
  const [amount, setAmount] = useState(range?.min ?? 0);
  // A new decision starts with the raise closed at its smallest amount.
  useEffect(() => {
    setRaising(false);
    setAmount(raiseRange(state)?.min ?? 0);
  }, [state.turns, state.hand]);
  const owe = toCall(state);
  const canFold = legal.some((m) => 'act' in m && m.act === 'fold');
  const presets = legal.flatMap((m) => ('act' in m && m.act === 'raise' ? [m.to] : []));
  const opening = state.bet === 0;
  const allIn = range ? amount >= range.max : false;
  const raiseWord = allIn ? 'All in' : opening ? 'Bet' : 'Raise to';
  const clamp = (v: number) => (range ? Math.min(range.max, Math.max(range.min, v)) : v);
  const presetLabel = (to: number, i: number) =>
    range && to >= range.max ? 'All in' : i === 0 ? 'Min' : formatChips(to);

  return (
    <View style={{ width }} className="gap-2">
      {raising && range && (
        <View className="gap-2 rounded-2xl bg-surface p-3">
          <View className="flex-row items-center justify-between">
            <Tap
              accessibilityRole="button"
              accessibilityLabel={`Less, ${formatChips(state.bb)} chips`}
              feedback="selection"
              onPress={() => setAmount(clamp(amount - state.bb))}
              className="h-11 w-11 items-center justify-center rounded-full bg-raised"
            >
              <Text className="text-xl font-bold text-foreground">−</Text>
            </Tap>
            <Text accessibilityLiveRegion="polite" className="text-2xl font-bold text-foreground">
              {formatChips(amount)}
            </Text>
            <Tap
              accessibilityRole="button"
              accessibilityLabel={`More, ${formatChips(state.bb)} chips`}
              feedback="selection"
              onPress={() => setAmount(clamp(amount + state.bb))}
              className="h-11 w-11 items-center justify-center rounded-full bg-raised"
            >
              <Text className="text-xl font-bold text-foreground">+</Text>
            </Tap>
          </View>
          <View className="flex-row flex-wrap justify-center gap-2">
            {presets.map((to, i) => (
              <Tap
                key={to}
                accessibilityRole="button"
                accessibilityLabel={`${presetLabel(to, i)}: ${formatChips(to)} chips`}
                feedback="selection"
                onPress={() => setAmount(to)}
                className={`rounded-full px-3 py-1.5 ${to === amount ? 'bg-primary' : 'bg-raised'}`}
              >
                <Text
                  className={`text-sm font-bold ${to === amount ? 'text-on-primary' : 'text-foreground'}`}
                >
                  {presetLabel(to, i)}
                </Text>
              </Tap>
            ))}
          </View>
        </View>
      )}
      <View className="flex-row gap-2">
        {canFold && (
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Fold"
            feedback="light"
            onPress={() => onMove({ act: 'fold' })}
            className="h-12 flex-1 items-center justify-center rounded-full bg-surface"
          >
            <Text className="font-bold text-foreground">Fold</Text>
          </Tap>
        )}
        <Tap
          accessibilityRole="button"
          accessibilityLabel={owe > 0 ? `Call ${formatChips(owe)} chips` : 'Check'}
          feedback="light"
          onPress={() => onMove(owe > 0 ? { act: 'call' } : { act: 'check' })}
          className="h-12 flex-1 items-center justify-center rounded-full bg-surface"
        >
          <Text className="font-bold text-foreground">
            {owe > 0
              ? owe >= state.stacks[state.current]!
                ? `All in ${formatChips(owe)}`
                : `Call ${formatChips(owe)}`
              : 'Check'}
          </Text>
        </Tap>
        {range && (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={
              raising ? `${raiseWord} ${formatChips(amount)} chips` : opening ? 'Bet' : 'Raise'
            }
            feedback="medium"
            onPress={() => {
              if (raising) onMove({ act: 'raise', to: amount });
              else setRaising(true);
            }}
            className="h-12 flex-1 items-center justify-center rounded-full bg-primary"
          >
            <Text numberOfLines={1} className="font-bold text-on-primary">
              {raising ? `${raiseWord} ${formatChips(amount)}` : opening ? 'Bet' : 'Raise'}
            </Text>
          </Tap>
        )}
      </View>
    </View>
  );
}
