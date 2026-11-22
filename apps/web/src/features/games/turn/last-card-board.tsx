// Last Card in the browser (Phase 45): the other hands as card backs with counts, the pile and
// the draw pile with the color in play, and the user's hand (playable cards lift; keys 1–9 play
// them, D draws, P keeps and passes). A wild asks for a color; with two cards left, "Last card!"
// must be pressed before playing one. PingDost's own card design.
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
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

import type { TurnBoardProps } from './boards';

const COLOR_NAMES = ['Red', 'Yellow', 'Green', 'Blue'];
const QUARTERS = [
  'M10 10 L10 1 A9 9 0 0 1 19 10 Z',
  'M10 10 L19 10 A9 9 0 0 1 10 19 Z',
  'M10 10 L10 19 A9 9 0 0 1 1 10 Z',
  'M10 10 L1 10 A9 9 0 0 1 10 1 Z',
];

function Symbol({ value, size, color }: { value: number; size: number; color: string }) {
  if (value === SKIP) {
    return (
      <svg aria-hidden width={size} height={size} viewBox="0 0 24 24">
        <circle cx={12} cy={12} r={8} stroke={color} strokeWidth={3} fill="none" />
        <line
          x1={6.5}
          y1={17.5}
          x2={17.5}
          y2={6.5}
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (value === REVERSE) {
    return (
      <svg aria-hidden width={size} height={size} viewBox="0 0 24 24">
        <path
          d="M5 9 h11 l-3 -3.5 M19 15 H8 l3 3.5"
          stroke={color}
          strokeWidth={2.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }
  return null;
}

export function CardFace({
  card,
  width,
  dark,
}: {
  card: number | null;
  width: number;
  dark: boolean;
}) {
  const colors = gameBoardColors(dark);
  const height = Math.round(width * 1.45);
  const radius = width * 0.14;
  if (card === null || card === 0) {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center border-2"
        style={{
          width,
          height,
          borderRadius: radius,
          backgroundColor: colors.cards.back,
          borderColor: colors.cards.edge,
        }}
      >
        <span
          className="block border-[3px]"
          style={{
            width: width * 0.62,
            height: height * 0.62,
            borderRadius: width,
            borderColor: colors.cards.pattern,
            transform: 'rotate(20deg)',
          }}
        />
      </span>
    );
  }
  const face = cardFace(card);
  const wild = isWild(card);
  const look = wild ? null : colors.players[LAST_CARD_COLORS[face.color]!];
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
    <span
      aria-hidden
      className="relative flex shrink-0 items-center justify-center border-2 shadow-md"
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundColor: look?.fill ?? colors.cards.wild,
        borderColor: colors.cards.edge,
      }}
    >
      <span
        className="relative flex items-center justify-center"
        style={{
          width: width * 0.7,
          height: width * 0.7,
          borderRadius: width,
          backgroundColor: colors.cards.shine,
        }}
      >
        {wild && (
          <svg aria-hidden width={width * 0.56} height={width * 0.56} viewBox="0 0 20 20">
            {LAST_CARD_COLORS.map((c, i) => (
              <path key={c} d={QUARTERS[i]} fill={colors.players[c].fill} />
            ))}
          </svg>
        )}
        {!wild && !label && <Symbol value={face.value} size={width * 0.5} color={ink} />}
        {label && (
          <span
            className={cn('font-extrabold', wild && 'absolute')}
            style={{ color: ink, fontSize: width * (label.length > 1 ? 0.3 : 0.42) }}
          >
            {label}
          </span>
        )}
      </span>
      <span className="absolute" style={{ left: width * 0.08, top: width * 0.04 }}>
        {label ? (
          <span className="font-extrabold" style={{ color: ink, fontSize: width * 0.18 }}>
            {label}
          </span>
        ) : (
          <Symbol value={face.value} size={width * 0.22} color={ink} />
        )}
      </span>
    </span>
  );
}

export function LastCardBoard({
  state,
  you,
  legal,
  last,
  onMove,
  dark,
  animate,
}: TurnBoardProps<LastCardState, LastCardMove>) {
  const colors = gameBoardColors(dark);
  const [wildFor, setWildFor] = useState<{ play: number; card: number } | null>(null);
  const [armed, setArmed] = useState(false);
  const plays = legal.filter((m): m is Extract<LastCardMove, { play: number }> => 'play' in m);
  const canDraw = legal.some((m) => 'draw' in m);
  const canPass = legal.some((m) => 'pass' in m && !('draw' in m));
  const playable = new Set(plays.map((m) => m.play));
  const mine = you >= 0 ? state.hands[you]! : [];
  const width = 64;
  const look = colors.players[LAST_CARD_COLORS[state.color]!];
  const needsCall = mine.length === 2 && plays.length > 0;
  const freshTop = !!last?.move && 'play' in last.move && animate;

  const playCard = (k: number, card: number) => {
    if (isWild(card)) {
      setWildFor({ play: k, card });
      return;
    }
    onMove({ play: k, card, call: armed });
    setArmed(false);
  };

  // Keys: 1–9 play the nth card that can be played, D draws, P keeps and passes.
  const latest = useRef({ plays, mine, canDraw, canPass, playCard, onMove });
  latest.current = { plays, mine, canDraw, canPass, playCard, onMove };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [role="dialog"], [role="menu"]')) return;
      const now = latest.current;
      const key = event.key.toLowerCase();
      if (key === 'd' && now.canDraw) now.onMove({ draw: true });
      else if (key === 'p' && now.canPass) now.onMove({ pass: true });
      else if (/^[1-9]$/.test(key)) {
        const cards = now.mine.filter((c) => now.plays.some((m) => m.play === c.k));
        const card = cards[Number(key) - 1];
        if (card) now.playCard(card.k, card.card);
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  return (
    <div className="relative flex w-full flex-col items-center gap-4">
      <div className="flex flex-wrap justify-center gap-5">
        {state.hands.map((hand, seat) =>
          seat === you || state.left[seat] ? null : (
            <div
              key={seat}
              aria-label={`${hand.length} cards`}
              className="flex flex-col items-center"
            >
              <div className="flex">
                {hand.slice(0, 6).map((c, i) => (
                  <span key={c.k} style={{ marginLeft: i === 0 ? 0 : -24 }}>
                    <CardFace card={null} width={36} dark={dark} />
                  </span>
                ))}
              </div>
              <span className="mt-1 text-xs font-bold text-muted">{hand.length}</span>
            </div>
          ),
        )}
      </div>

      <div className="flex items-center justify-center gap-6">
        <button
          type="button"
          disabled={!canDraw}
          aria-label={canDraw ? 'Draw a card (D)' : 'Draw pile'}
          onClick={() => onMove({ draw: true })}
          className="pd-press flex cursor-pointer flex-col items-center gap-1 disabled:cursor-default"
        >
          <CardFace card={null} width={70} dark={dark} />
          {canDraw && <span className="text-xs font-bold text-accent">Draw</span>}
        </button>
        <span
          key={`top-${freshTop ? last?.id : 'still'}`}
          aria-label={`On the pile: ${cardName(state.top)}, ${COLOR_NAMES[state.color]} in play`}
          className={freshTop ? 'pd-pop' : undefined}
        >
          <CardFace card={state.top} width={84} dark={dark} />
        </span>
        <span className="flex flex-col items-center gap-1">
          <span
            className="block size-6 rounded-full border-2"
            style={{ backgroundColor: look.fill, borderColor: look.ring }}
          />
          <RotateCcw
            aria-label={
              state.direction === 1 ? 'Play goes clockwise' : 'Play goes counterclockwise'
            }
            size={18}
            className="text-muted"
            style={{ transform: state.direction === 1 ? 'scaleX(-1)' : undefined }}
          />
        </span>
      </div>

      {you >= 0 && (
        <div className="flex w-full flex-col gap-2">
          <div className="flex min-h-10 items-center justify-center gap-2">
            {needsCall && (
              <button
                type="button"
                role="switch"
                aria-checked={armed}
                onClick={() => setArmed(!armed)}
                className={cn(
                  'pd-press cursor-pointer rounded-full px-4 py-2 font-bold',
                  armed ? 'bg-primary text-on-primary' : 'bg-surface',
                )}
              >
                {armed ? 'Last card! (called)' : 'Last card!'}
              </button>
            )}
            {canPass && (
              <button
                type="button"
                onClick={() => onMove({ pass: true })}
                className="pd-press cursor-pointer rounded-full bg-surface px-4 py-2 font-bold"
              >
                Keep and pass (P)
              </button>
            )}
          </div>
          <div className="flex justify-center overflow-x-auto px-2 pt-4">
            {mine.map((c, i) => {
              const ok = playable.has(c.k);
              return (
                <button
                  key={c.k}
                  type="button"
                  disabled={!ok}
                  aria-label={`${cardName(c.card)}${ok ? '. Play it' : ''}`}
                  onClick={() => playCard(c.k, c.card)}
                  className={cn(
                    'shrink-0 cursor-pointer transition-transform disabled:cursor-default',
                    ok && '-translate-y-3',
                    plays.length > 0 && !ok && 'opacity-55',
                  )}
                  style={{ marginLeft: i === 0 ? 0 : -18 }}
                >
                  <CardFace card={c.card} width={width} dark={dark} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {wildFor && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/45">
          <div
            role="dialog"
            aria-label="Pick the next color"
            className="pd-pop flex flex-col gap-3 rounded-2xl bg-surface p-4"
          >
            <p className="text-center font-bold">Pick the next color</p>
            <div className="flex gap-3">
              {LAST_CARD_COLORS.map((c, color) => (
                <button
                  key={c}
                  type="button"
                  aria-label={COLOR_NAMES[color]}
                  onClick={() => {
                    onMove({ ...wildFor, color, call: armed });
                    setArmed(false);
                    setWildFor(null);
                  }}
                  className="pd-press size-12 cursor-pointer rounded-full border-[3px]"
                  style={{
                    backgroundColor: colors.players[c].fill,
                    borderColor: colors.players[c].ring,
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => setWildFor(null)}
              className="cursor-pointer text-sm text-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
