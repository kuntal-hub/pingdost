// Call Bridge on the phone (Phase 46): the trick in the middle with each card at its player's
// side (the user at the bottom), the user's 13 cards sorted by suit along the bottom (playable
// ones stand up), a picker for the call, notes while the dealer deals or shows the deal, and the
// round-by-round scores. Suits are drawn shapes, not font glyphs.
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { useTheme } from '@/theme/theme-root';
import {
  bridgeCardName,
  isRedSuit,
  rankLabel,
  rankOf,
  SUIT_BOX,
  SUIT_PATHS,
  suitOf,
  type BridgeMove,
  type BridgePlay,
  type BridgeState,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import type { TurnBoardProps } from './board-props';

const SEATS = ['North', 'East', 'South', 'West'];
/** Hand order: spades, hearts, clubs, diamonds (colors alternate), high to low. */
const SUIT_ORDER = [0, 1, 3, 2];

export function PlayingCard({
  card,
  width,
  dark,
  raised = false,
  dim = false,
}: {
  card: number | null;
  width: number;
  dark: boolean;
  raised?: boolean;
  dim?: boolean;
}) {
  const { cards } = gameBoardColors(dark);
  const height = Math.round(width * 1.42);
  const radius = width * 0.12;
  if (card === null || card < 0) {
    return (
      <View
        style={{
          width,
          height,
          borderRadius: radius,
          backgroundColor: cards.back,
          borderWidth: 2,
          borderColor: cards.edge,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: width * 0.6,
            height: height * 0.6,
            borderRadius: width,
            borderWidth: 3,
            borderColor: cards.pattern,
            transform: [{ rotate: '20deg' }],
          }}
        />
      </View>
    );
  }
  const suit = suitOf(card);
  const ink = isRedSuit(suit) ? cards.red : cards.black;
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundColor: cards.face,
        borderWidth: 1,
        borderColor: cards.pattern,
        padding: width * 0.06,
        opacity: dim ? 0.55 : 1,
        transform: [{ translateY: raised ? -width * 0.16 : 0 }],
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
      }}
    >
      <Text
        style={{ color: ink, fontSize: width * 0.26, fontWeight: '800', lineHeight: width * 0.3 }}
      >
        {rankLabel(card)}
      </Text>
      <Svg width={width * 0.24} height={width * 0.24} viewBox={`0 0 ${SUIT_BOX} ${SUIT_BOX}`}>
        <Path d={SUIT_PATHS[suit]} fill={ink} />
      </Svg>
      <View style={{ position: 'absolute', right: width * 0.08, bottom: width * 0.1 }}>
        <Svg width={width * 0.46} height={width * 0.46} viewBox={`0 0 ${SUIT_BOX} ${SUIT_BOX}`}>
          <Path d={SUIT_PATHS[suit]} fill={ink} />
        </Svg>
      </View>
    </View>
  );
}

/** Where a seat's card lands in the trick, relative to the user at the bottom. */
function spot(seat: number, you: number, size: number, card: number) {
  const rel = (seat - Math.max(0, you) + 4) % 4;
  const h = card * 1.42;
  const cx = size / 2 - card / 2;
  const cy = size * 0.3 - h / 2;
  return [
    { left: cx, top: cy + h * 0.55 },
    { left: cx - card * 1.05, top: cy },
    { left: cx, top: cy - h * 0.55 },
    { left: cx + card * 1.05, top: cy },
  ][rel]!;
}

export function CallBridgeBoard({
  state,
  you,
  legal,
  onMove,
  size,
  dark,
}: TurnBoardProps<BridgeState, BridgeMove>) {
  const { card: cardStyle } = useTheme();
  const [scores, setScores] = useState(false);
  const plays = legal.filter((m): m is { play: number; card: number } => 'play' in m);
  const calls = legal.filter((m): m is { call: number } => 'call' in m);
  const playable = new Set(plays.map((m) => m.play));
  const hand = you >= 0 ? [...state.hands[you]!] : [];
  hand.sort(
    (a, b) =>
      SUIT_ORDER.indexOf(suitOf(a.card)) - SUIT_ORDER.indexOf(suitOf(b.card)) ||
      rankOf(b.card) - rankOf(a.card),
  );
  const cardWidth = Math.min(56, Math.floor((size - 16) / 7.2));
  const trickCard = Math.min(58, Math.floor(size / 6.2));
  const shown: BridgePlay[] = state.trick.length > 0 ? state.trick : (state.lastTrick?.plays ?? []);
  const winner = state.trick.length === 0 ? state.lastTrick?.winner : undefined;
  const dealerName = state.dealer === you ? 'You' : SEATS[state.dealer];
  const note =
    state.phase === 'deal'
      ? `${dealerName === 'You' ? 'You are dealing' : `${dealerName} is dealing`}…`
      : state.phase === 'reveal'
        ? 'The dealer shows the deal so everyone can check it…'
        : state.phase === 'call' && calls.length > 0
          ? 'How many tricks will you take?'
          : null;

  return (
    <View style={{ width: size, gap: 10, alignItems: 'center' }}>
      <View style={{ width: size, height: size * 0.62 }}>
        {shown.map((p) => (
          <View
            key={`${p.seat}-${p.card}`}
            accessibilityLabel={`${p.seat === you ? 'You' : SEATS[p.seat]}: ${bridgeCardName(p.card)}${winner === p.seat ? ', takes the trick' : ''}`}
            style={{
              position: 'absolute',
              ...spot(p.seat, you, size, trickCard),
              opacity: winner !== undefined && winner !== p.seat ? 0.6 : 1,
            }}
          >
            <PlayingCard card={p.card} width={trickCard} dark={dark} />
          </View>
        ))}
        {note && (
          <View className="absolute inset-x-0 bottom-1 items-center">
            <Text
              accessibilityLiveRegion="polite"
              className="text-center text-sm font-bold text-foreground"
            >
              {note}
            </Text>
          </View>
        )}
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`Round ${Math.min(state.round + 1, 5)} of 5. Scores`}
          onPress={() => setScores(!scores)}
          className="absolute right-1 top-1 rounded-full bg-surface px-3 py-1"
        >
          <Text className="text-xs font-bold text-foreground">
            Round {Math.min(state.round + 1, 5)}/5 · Scores
          </Text>
        </Tap>
      </View>

      {calls.length > 0 && (
        <View className="flex-row flex-wrap justify-center gap-2" style={{ width: size }}>
          {calls.map((m) => (
            <Tap
              key={m.call}
              accessibilityRole="button"
              accessibilityLabel={`Call ${m.call}`}
              feedback="selection"
              onPress={() => onMove(m)}
              className="h-11 w-11 items-center justify-center rounded-full bg-primary"
            >
              <Text className="text-base font-bold text-on-primary">{m.call}</Text>
            </Tap>
          ))}
        </View>
      )}

      {you >= 0 && hand.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingTop: cardWidth * 0.2, paddingHorizontal: 6 }}
        >
          {hand.map((c, i) => {
            const ok = playable.has(c.p);
            return (
              <Tap
                key={c.p}
                accessibilityRole="button"
                accessibilityLabel={
                  c.card >= 0 ? `${bridgeCardName(c.card)}${ok ? '. Play it' : ''}` : 'A card'
                }
                accessibilityState={{ disabled: !ok }}
                disabled={!ok}
                feedback="light"
                onPress={() => onMove({ play: c.p, card: c.card })}
                style={{ marginLeft: i === 0 ? 0 : -cardWidth * 0.42 }}
              >
                <PlayingCard
                  card={c.card}
                  width={cardWidth}
                  dark={dark}
                  raised={ok}
                  dim={plays.length > 0 && !ok}
                />
              </Tap>
            );
          })}
        </ScrollView>
      )}

      {scores && (
        <View className="w-full gap-1 rounded-2xl bg-surface p-3" style={cardStyle}>
          <View className="flex-row">
            <Text className="flex-1 text-xs font-bold text-muted">Round</Text>
            {SEATS.map((name, s) => (
              <Text key={name} className="w-[18%] text-center text-xs font-bold text-muted">
                {s === you ? 'You' : name}
              </Text>
            ))}
          </View>
          {state.history.map((round, r) => (
            <View key={r} className="flex-row">
              <Text className="flex-1 text-xs text-foreground">{r + 1}</Text>
              {round.points.map((p, s) => (
                <Text key={s} className="w-[18%] text-center text-xs text-foreground">
                  {(p / 10).toFixed(1)} ({round.tricks[s]}/{round.calls[s]})
                  {round.revoked.includes(s) ? ' revoke' : ''}
                </Text>
              ))}
            </View>
          ))}
          <View className="flex-row border-t border-border pt-1">
            <Text className="flex-1 text-xs font-bold text-foreground">Total</Text>
            {state.scores.map((v, s) => (
              <Text key={s} className="w-[18%] text-center text-xs font-bold text-foreground">
                {(v / 10).toFixed(1)}
              </Text>
            ))}
          </View>
          {state.badDeal && (
            <Text className="text-xs text-danger">
              A dealer's cards didn't match the deal it promised.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
