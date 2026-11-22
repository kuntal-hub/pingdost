// Last Card on the phone (Phase 45): the other players' hands as card backs with counts, the
// pile and the draw pile in the middle with the color in play, and the user's hand along the
// bottom (cards that can be played stand up). A wild asks for a color; with two cards left,
// "Last card!" must be tapped before playing one. Cards are PingDost's own design.
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { Icon, RotateCcwIcon } from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { CSS_POP } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import {
  cardFace,
  cardName,
  DRAW_TWO,
  isWild,
  LAST_CARD_COLORS,
  REVERSE,
  SKIP,
  WILD_DRAW_FOUR,
  type LastCardMove,
  type LastCardState,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { POP_IN, type TurnBoardProps } from './board-props';

function Symbol({ value, size, color }: { value: number; size: number; color: string }) {
  const s = size;
  if (value === SKIP) {
    return (
      <Svg width={s} height={s} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={8} stroke={color} strokeWidth={3} fill="none" />
        <Line
          x1={6.5}
          y1={17.5}
          x2={17.5}
          y2={6.5}
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
        />
      </Svg>
    );
  }
  if (value === REVERSE) {
    return (
      <Svg width={s} height={s} viewBox="0 0 24 24">
        <Path
          d="M5 9 h11 l-3 -3.5 M19 15 H8 l3 3.5"
          stroke={color}
          strokeWidth={2.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    );
  }
  return null;
}

/** One card face (or its back). */
export function CardView({
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
  const colors = gameBoardColors(dark);
  const height = Math.round(width * 1.45);
  const radius = width * 0.14;
  if (card === null || card === 0) {
    // The back: the brand-neutral pattern, the same for every card.
    return (
      <View
        style={{
          width,
          height,
          borderRadius: radius,
          backgroundColor: colors.cards.back,
          borderWidth: 2,
          borderColor: colors.cards.edge,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: width * 0.62,
            height: height * 0.62,
            borderRadius: width * 0.31,
            borderWidth: 3,
            borderColor: colors.cards.pattern,
            transform: [{ rotate: '20deg' }],
          }}
        />
      </View>
    );
  }
  const face = cardFace(card);
  const wild = isWild(card);
  const look = wild ? null : colors.players[LAST_CARD_COLORS[face.color]!];
  const fill = look?.fill ?? colors.cards.wild;
  const ink = look?.on ?? colors.cards.edge;
  const label =
    face.value <= 9
      ? String(face.value)
      : face.value === DRAW_TWO
        ? '+2'
        : face.value === WILD_DRAW_FOUR
          ? '+4'
          : '';
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundColor: fill,
        borderWidth: 2,
        borderColor: colors.cards.edge,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: dim ? 0.55 : 1,
        transform: [{ translateY: raised ? -width * 0.18 : 0 }],
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.3)',
      }}
    >
      <View
        style={{
          width: width * 0.7,
          height: width * 0.7,
          borderRadius: width,
          backgroundColor: colors.cards.shine,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {wild ? (
          <Svg width={width * 0.56} height={width * 0.56} viewBox="0 0 20 20">
            {LAST_CARD_COLORS.map((c, i) => (
              <Path
                key={c}
                d={
                  [
                    'M10 10 L10 1 A9 9 0 0 1 19 10 Z',
                    'M10 10 L19 10 A9 9 0 0 1 10 19 Z',
                    'M10 10 L10 19 A9 9 0 0 1 1 10 Z',
                    'M10 10 L1 10 A9 9 0 0 1 10 1 Z',
                  ][i]
                }
                fill={colors.players[c].fill}
              />
            ))}
          </Svg>
        ) : label ? null : (
          <Symbol value={face.value} size={width * 0.5} color={ink} />
        )}
        {label !== '' && (
          <Text
            style={{
              position: wild ? 'absolute' : 'relative',
              color: ink,
              fontSize: width * (label.length > 1 ? 0.3 : 0.42),
              fontWeight: '800',
            }}
          >
            {label}
          </Text>
        )}
      </View>
      <View style={{ position: 'absolute', left: width * 0.08, top: width * 0.04 }}>
        {label ? (
          <Text style={{ color: ink, fontSize: width * 0.18, fontWeight: '800' }}>{label}</Text>
        ) : (
          <Symbol value={face.value} size={width * 0.22} color={ink} />
        )}
      </View>
    </View>
  );
}

const COLOR_NAMES = ['Red', 'Yellow', 'Green', 'Blue'];

export function LastCardBoard({
  state,
  you,
  legal,
  last,
  onMove,
  size,
  dark,
  moves,
  pace,
}: TurnBoardProps<LastCardState, LastCardMove>) {
  const { palette } = useTheme();
  const colors = gameBoardColors(dark);
  const [wildFor, setWildFor] = useState<{ play: number; card: number } | null>(null);
  const [armed, setArmed] = useState(false);
  const plays = legal.filter((m): m is Extract<LastCardMove, { play: number }> => 'play' in m);
  const canDraw = legal.some((m) => 'draw' in m);
  const canPass = legal.some((m) => 'pass' in m && !('draw' in m));
  const playable = new Set(plays.map((m) => m.play));
  const mine = you >= 0 ? state.hands[you]! : [];
  const cardWidth = Math.min(64, Math.floor(size / 6));
  const colorLook = colors.players[LAST_CARD_COLORS[state.color]!];
  const needsCall = mine.length === 2 && plays.length > 0;
  const freshTop = last?.move && 'play' in (last.move);

  const playCard = (k: number, card: number) => {
    if (isWild(card)) {
      setWildFor({ play: k, card });
      return;
    }
    onMove({ play: k, card, call: armed });
    setArmed(false);
  };

  return (
    <View style={{ width: size, gap: 14, alignItems: 'center' }}>
      <View className="flex-row flex-wrap justify-center gap-4">
        {state.hands.map((hand, seat) =>
          seat === you || state.left[seat] ? null : (
            <View key={seat} accessibilityLabel={`${hand.length} cards`} className="items-center">
              <View className="flex-row">
                {hand.slice(0, 6).map((c, i) => (
                  <View key={c.k} style={{ marginLeft: i === 0 ? 0 : -cardWidth * 0.55 }}>
                    <CardView card={null} width={cardWidth * 0.55} dark={dark} />
                  </View>
                ))}
              </View>
              <Text className="mt-1 text-xs font-bold text-muted">{hand.length}</Text>
            </View>
          ),
        )}
      </View>

      <View className="flex-row items-center justify-center gap-6">
        <Tap
          accessibilityRole="button"
          accessibilityLabel={canDraw ? 'Draw a card' : 'Draw pile'}
          accessibilityState={{ disabled: !canDraw }}
          disabled={!canDraw}
          feedback="light"
          onPress={() => onMove({ draw: true })}
        >
          <CardView card={null} width={cardWidth * 1.1} dark={dark} />
          {canDraw && <Text className="mt-1 text-center text-xs font-bold text-accent">Draw</Text>}
        </Tap>
        <Animated.View
          key={`top-${freshTop ? last?.id : 'still'}`}
          accessibilityLabel={`On the pile: ${cardName(state.top)}, ${COLOR_NAMES[state.color]} in play`}
          style={
            freshTop && moves
              ? {
                  animationName: POP_IN,
                  animationDuration: pace.step + 120,
                  animationTimingFunction: CSS_POP,
                }
              : undefined
          }
        >
          <CardView card={state.top} width={cardWidth * 1.3} dark={dark} />
        </Animated.View>
        <View className="items-center gap-1">
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: colorLook.fill,
              borderWidth: 2,
              borderColor: colorLook.ring,
            }}
          />
          <View
            accessibilityLabel={
              state.direction === 1 ? 'Play goes clockwise' : 'Play goes counterclockwise'
            }
            style={{ transform: [{ scaleX: state.direction === 1 ? -1 : 1 }] }}
          >
            <Icon icon={RotateCcwIcon} size={18} color="muted" />
          </View>
        </View>
      </View>

      {you >= 0 && (
        <View style={{ width: size }} className="gap-2">
          <View className="min-h-[40px] flex-row items-center justify-center gap-2">
            {needsCall && (
              <Tap
                accessibilityRole="switch"
                accessibilityState={{ checked: armed }}
                accessibilityLabel="Last card!"
                feedback="medium"
                onPress={() => setArmed(!armed)}
                className="rounded-full px-4 py-2"
                style={{ backgroundColor: armed ? palette.primary : palette.surface }}
              >
                <Text className={`font-bold ${armed ? 'text-on-primary' : 'text-foreground'}`}>
                  {armed ? 'Last card! (called)' : 'Last card!'}
                </Text>
              </Tap>
            )}
            {canPass && (
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Keep the card and pass"
                feedback="light"
                onPress={() => onMove({ pass: true })}
                className="rounded-full bg-surface px-4 py-2"
              >
                <Text className="font-bold text-foreground">Keep and pass</Text>
              </Tap>
            )}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingTop: cardWidth * 0.22, paddingHorizontal: 8 }}
          >
            {mine.map((c, i) => {
              const ok = playable.has(c.k);
              return (
                <Tap
                  key={c.k}
                  accessibilityRole="button"
                  accessibilityLabel={`${cardName(c.card)}${ok ? '. Play it' : ''}`}
                  accessibilityState={{ disabled: !ok }}
                  disabled={!ok}
                  feedback="light"
                  onPress={() => playCard(c.k, c.card)}
                  style={{ marginLeft: i === 0 ? 0 : -cardWidth * 0.3 }}
                >
                  <CardView
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
        </View>
      )}

      {wildFor && (
        <View
          className="absolute inset-0 items-center justify-center"
          style={{ backgroundColor: 'rgba(5, 5, 15, 0.45)', zIndex: 10 }}
        >
          <View accessibilityViewIsModal className="gap-3 rounded-2xl bg-surface p-4">
            <Text className="text-center font-bold text-foreground">Pick the next color</Text>
            <View className="flex-row gap-3">
              {LAST_CARD_COLORS.map((c, color) => (
                <Tap
                  key={c}
                  accessibilityRole="button"
                  accessibilityLabel={COLOR_NAMES[color]}
                  feedback="selection"
                  onPress={() => {
                    onMove({ ...wildFor, color, call: armed });
                    setArmed(false);
                    setWildFor(null);
                  }}
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 26,
                    backgroundColor: colors.players[c].fill,
                    borderWidth: 3,
                    borderColor: colors.players[c].ring,
                  }}
                />
              ))}
            </View>
            <Tap
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={() => setWildFor(null)}
              className="items-center py-1"
            >
              <Text className="text-sm text-muted">Cancel</Text>
            </Tap>
          </View>
        </View>
      )}
    </View>
  );
}
