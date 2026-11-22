// Call Bridge in the browser (Phase 46): the trick in the middle with each card at its player's
// side (the user at the bottom), the user's cards sorted by suit (playable ones lift; keys 1–9
// play the nth playable card), the call picker, notes while the dealer deals or shows the deal,
// and the round-by-round scores. Suits are drawn shapes, not font glyphs.
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
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

import type { TurnBoardProps } from './boards';

const SEATS = ['North', 'East', 'South', 'West'];
const SUIT_ORDER = [0, 1, 3, 2];

export function PlayingCard({
  card,
  width,
  dark,
}: {
  card: number | null;
  width: number;
  dark: boolean;
}) {
  const { cards } = gameBoardColors(dark);
  const height = Math.round(width * 1.42);
  const radius = width * 0.12;
  if (card === null || card < 0) {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center border-2"
        style={{
          width,
          height,
          borderRadius: radius,
          backgroundColor: cards.back,
          borderColor: cards.edge,
        }}
      >
        <span
          className="block border-[3px]"
          style={{
            width: width * 0.6,
            height: height * 0.6,
            borderRadius: width,
            borderColor: cards.pattern,
            transform: 'rotate(20deg)',
          }}
        />
      </span>
    );
  }
  const suit = suitOf(card);
  const ink = isRedSuit(suit) ? cards.red : cards.black;
  return (
    <span
      aria-hidden
      className="relative block shrink-0 border shadow-sm"
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundColor: cards.face,
        borderColor: cards.pattern,
        padding: width * 0.06,
      }}
    >
      <span
        className="block font-extrabold leading-none"
        style={{ color: ink, fontSize: width * 0.26 }}
      >
        {rankLabel(card)}
      </span>
      <svg width={width * 0.24} height={width * 0.24} viewBox={`0 0 ${SUIT_BOX} ${SUIT_BOX}`}>
        <path d={SUIT_PATHS[suit]} fill={ink} />
      </svg>
      <svg
        className="absolute"
        style={{ right: width * 0.08, bottom: width * 0.1 }}
        width={width * 0.46}
        height={width * 0.46}
        viewBox={`0 0 ${SUIT_BOX} ${SUIT_BOX}`}
      >
        <path d={SUIT_PATHS[suit]} fill={ink} />
      </svg>
    </span>
  );
}

const POSITIONS = [
  'left-1/2 top-[58%] -translate-x-1/2 -translate-y-1/2',
  'left-[28%] top-[38%] -translate-x-1/2 -translate-y-1/2',
  'left-1/2 top-[18%] -translate-x-1/2 -translate-y-1/2',
  'left-[72%] top-[38%] -translate-x-1/2 -translate-y-1/2',
];

export function CallBridgeBoard({
  state,
  you,
  legal,
  onMove,
  dark,
}: TurnBoardProps<BridgeState, BridgeMove>) {
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
  const shown: BridgePlay[] = state.trick.length > 0 ? state.trick : (state.lastTrick?.plays ?? []);
  const winner = state.trick.length === 0 ? state.lastTrick?.winner : undefined;
  const dealerName = state.dealer === you ? 'You' : SEATS[state.dealer];
  const note =
    state.phase === 'deal'
      ? dealerName === 'You'
        ? 'You are dealing…'
        : `${dealerName} is dealing…`
      : state.phase === 'reveal'
        ? 'The dealer shows the deal so everyone can check it…'
        : state.phase === 'call' && calls.length > 0
          ? 'How many tricks will you take? (keys 1–9, 0 for 10)'
          : null;

  const latest = useRef({ plays, calls, hand, onMove });
  latest.current = { plays, calls, hand, onMove };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [role="dialog"], [role="menu"]')) return;
      if (!/^[0-9]$/.test(event.key)) return;
      const now = latest.current;
      const n = event.key === '0' ? 10 : Number(event.key);
      if (now.calls.length > 0) {
        const call = now.calls.find((m) => m.call === n);
        if (call) now.onMove(call);
        return;
      }
      const cards = now.hand.filter((c) => now.plays.some((m) => m.play === c.p));
      const card = cards[n - 1];
      if (card) now.onMove({ play: card.p, card: card.card });
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div className="relative w-full" style={{ aspectRatio: '1.6' }}>
        {shown.map((p) => (
          <span
            key={`${p.seat}-${p.card}`}
            aria-label={`${p.seat === you ? 'You' : SEATS[p.seat]}: ${bridgeCardName(p.card)}${winner === p.seat ? ', takes the trick' : ''}`}
            className={cn(
              'absolute',
              POSITIONS[(p.seat - Math.max(0, you) + 4) % 4],
              winner !== undefined && winner !== p.seat && 'opacity-60',
            )}
          >
            <PlayingCard card={p.card} width={62} dark={dark} />
          </span>
        ))}
        {note && (
          <p
            aria-live="polite"
            className="absolute inset-x-0 bottom-0 text-center text-sm font-bold"
          >
            {note}
          </p>
        )}
        <button
          type="button"
          onClick={() => setScores(!scores)}
          className="pd-press absolute right-1 top-1 cursor-pointer rounded-full bg-surface px-3 py-1 text-xs font-bold"
        >
          Round {Math.min(state.round + 1, 5)}/5 · Scores
        </button>
      </div>

      {calls.length > 0 && (
        <div role="group" aria-label="Your call" className="flex flex-wrap justify-center gap-2">
          {calls.map((m) => (
            <button
              key={m.call}
              type="button"
              aria-label={`Call ${m.call}`}
              onClick={() => onMove(m)}
              className="pd-press size-10 cursor-pointer rounded-full bg-primary font-bold text-on-primary"
            >
              {m.call}
            </button>
          ))}
        </div>
      )}

      {you >= 0 && hand.length > 0 && (
        <div className="flex justify-center overflow-x-auto px-2 pt-4">
          {hand.map((c, i) => {
            const ok = playable.has(c.p);
            return (
              <button
                key={c.p}
                type="button"
                disabled={!ok}
                aria-label={
                  c.card >= 0 ? `${bridgeCardName(c.card)}${ok ? '. Play it' : ''}` : 'A card'
                }
                onClick={() => onMove({ play: c.p, card: c.card })}
                className={cn(
                  'shrink-0 cursor-pointer transition-transform disabled:cursor-default',
                  ok && '-translate-y-3',
                  plays.length > 0 && !ok && 'opacity-55',
                )}
                style={{ marginLeft: i === 0 ? 0 : -22 }}
              >
                <PlayingCard card={c.card} width={56} dark={dark} />
              </button>
            );
          })}
        </div>
      )}

      {scores && (
        <table className="pd-card w-full rounded-2xl p-3 text-xs">
          <thead>
            <tr className="text-muted">
              <th className="text-left">Round</th>
              {SEATS.map((name, s) => (
                <th key={name}>{s === you ? 'You' : name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.history.map((round, r) => (
              <tr key={r}>
                <td>{r + 1}</td>
                {round.points.map((p, s) => (
                  <td key={s} className="text-center">
                    {(p / 10).toFixed(1)} ({round.tricks[s]}/{round.calls[s]})
                    {round.revoked.includes(s) ? ' revoke' : ''}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="font-bold">
              <td>Total</td>
              {state.scores.map((v, s) => (
                <td key={s} className="text-center">
                  {(v / 10).toFixed(1)}
                </td>
              ))}
            </tr>
          </tbody>
          {state.badDeal && (
            <caption className="caption-bottom text-danger">
              A dealer's cards didn't match the deal it promised.
            </caption>
          )}
        </table>
      )}
    </div>
  );
}
