// Poker in the browser (Phase 47): the table (the pot, the five shared cards, how the last hand
// ended), the hands shown at the showdown, the user's two cards with what they make, and the
// betting bar (fold, check or call, a raise with a slider and presets; keys F, C and R).
// Everyone's chips, bets and folds are in the players' strip above. Play chips only.
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
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

import type { TurnBoardProps } from './boards';
import { PlayingCard } from './call-bridge-board';

/** The result the table shows between hands (null while a hand is played). */
function shownResult(state: PokerState): PokerResult | null {
  if (state.phase === 'reveal' || state.phase === 'done') return state.last;
  if (state.phase === 'deal' && state.last && state.last.hand === state.hand - 1) return state.last;
  return null;
}

export function PokerBoard({
  state,
  you,
  legal,
  onMove,
  dark,
  last,
  animate,
  names,
}: TurnBoardProps<PokerState, PokerMove>) {
  const { felt } = gameBoardColors(dark);
  const name = (seat: number) => names?.(seat) ?? (seat === you ? 'You' : `Seat ${seat + 1}`);
  const result = shownResult(state);
  const board = result ? result.board : state.board;
  const pot = potTotal(state);
  const pots = pot > 0 ? buildPots(state.contrib, liveSeats(state)) : [];
  const freshFrom =
    last && animate && last.state.board.length > last.before.board.length
      ? last.before.board.length
      : 5;
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
    <div className="flex w-full flex-col items-center gap-3">
      <div
        className="flex w-full flex-col items-center justify-center gap-2 border-[6px] px-4 py-3"
        style={{
          minHeight: 220,
          borderRadius: 96,
          backgroundColor: felt.cloth,
          borderColor: felt.rim,
          color: felt.ink,
        }}
      >
        <p className="text-xs font-bold">
          Hand {state.hand + 1} · Blinds {formatChips(state.sb)}/{formatChips(state.bb)}
        </p>
        <p className="min-h-6 text-base font-bold" aria-label={`Pot ${formatChips(pot)} chips`}>
          {pot > 0 ? `Pot ${formatChips(pot)}` : ''}
          {pots.length > 1 &&
            ` · ${pots.map((p, i) => `${i === 0 ? 'main' : 'side'} ${formatChips(p.amount)}`).join(' · ')}`}
        </p>
        <div
          className="flex gap-1.5"
          role="img"
          aria-label={
            board.length > 0
              ? `On the table: ${board.map(bridgeCardName).join(', ')}`
              : 'No shared cards yet'
          }
        >
          {Array.from({ length: 5 }, (_, i) => {
            const value = board[i];
            if (value === undefined) {
              return (
                <span
                  key={i}
                  aria-hidden
                  className="block border-2 border-dashed"
                  style={{ width: 54, height: 77, borderRadius: 6, borderColor: felt.slot }}
                />
              );
            }
            const fresh = i >= freshFrom;
            return (
              <span
                key={`${state.hand}-${i}-${fresh ? last?.id : 'still'}`}
                className={fresh ? 'pd-pop' : undefined}
              >
                <PlayingCard card={value} width={54} dark={dark} />
              </span>
            );
          })}
        </div>
        {result && (
          <p aria-live="polite" className="text-center text-sm font-bold">
            {pokerResultLine(result, name)}
          </p>
        )}
      </div>

      {showdown.length > 0 && (
        <ul className="flex w-full flex-col gap-1.5">
          {showdown.map(({ seat, cards, score }) => {
            const won = result ? result.won[seat]! : 0;
            return (
              <li
                key={seat}
                aria-label={`${name(seat)}: ${cards.map(bridgeCardName).join(' and ')}${score !== null ? `, ${handName(score)}` : ''}${won > 0 ? ', wins' : ''}`}
                className={cn(
                  'flex items-center gap-2 rounded-2xl px-3 py-1.5',
                  won > 0 && 'bg-surface',
                )}
              >
                <span className="w-28 truncate text-sm font-bold">{name(seat)}</span>
                {cards.map((c) => (
                  <PlayingCard key={c} card={c} width={30} dark={dark} />
                ))}
                <span className="flex-1 truncate text-sm text-muted">
                  {score !== null ? handName(score) : ''}
                  {won > 0 ? ` · +${formatChips(won)}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {you >= 0 && state.dealt[you] && !result && (
        <div className="flex flex-col items-center gap-1">
          <div
            role="img"
            aria-label={
              known
                ? `Your cards: ${mine.map(bridgeCardName).join(' and ')}`
                : 'Your cards are on the way'
            }
            className={cn('flex gap-2', folded && 'opacity-45')}
          >
            {(mine.length === 2 ? mine : [-1, -1]).map((c, i) => (
              <PlayingCard key={i} card={c} width={66} dark={dark} />
            ))}
          </div>
          <p className="min-h-5 text-sm font-bold text-muted">
            {folded ? 'You folded' : (made ?? (known ? '' : 'Waiting for your cards…'))}
          </p>
        </div>
      )}

      {legal.length > 0 && <BettingBar state={state} legal={legal} onMove={onMove} />}
    </div>
  );
}

function BettingBar({
  state,
  legal,
  onMove,
}: {
  state: PokerState;
  legal: readonly PokerMove[];
  onMove: (move: PokerMove) => void;
}) {
  const range = raiseRange(state);
  const [raising, setRaising] = useState(false);
  const [amount, setAmount] = useState(range?.min ?? 0);
  // A new decision starts with the raise closed at its smallest amount.
  useEffect(() => {
    setRaising(false);
    setAmount(raiseRange(state)?.min ?? 0);
    // Only a new step or hand resets it, not every redraw of the same state.
  }, [state.turns, state.hand]);
  const owe = toCall(state);
  const canFold = legal.some((m) => 'act' in m && m.act === 'fold');
  const presets = legal.flatMap((m) => ('act' in m && m.act === 'raise' ? [m.to] : []));
  const opening = state.bet === 0;
  const allIn = range ? amount >= range.max : false;
  const raiseWord = allIn ? 'All in' : opening ? 'Bet' : 'Raise to';
  const callLabel =
    owe > 0
      ? owe >= state.stacks[state.current]!
        ? `All in ${formatChips(owe)}`
        : `Call ${formatChips(owe)}`
      : 'Check';
  const presetLabel = (to: number, i: number) =>
    range && to >= range.max ? 'All in' : i === 0 ? 'Min' : formatChips(to);

  const latest = useRef({ owe, canFold, range, raising, amount, onMove });
  latest.current = { owe, canFold, range, raising, amount, onMove };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input:not([type="range"]), textarea, [role="dialog"], [role="menu"]'))
        return;
      const now = latest.current;
      const key = event.key.toLowerCase();
      if (key === 'f' && now.canFold) now.onMove({ act: 'fold' });
      else if (key === 'c') now.onMove(now.owe > 0 ? { act: 'call' } : { act: 'check' });
      else if (key === 'r' && now.range) {
        if (now.raising) now.onMove({ act: 'raise', to: now.amount });
        else setRaising(true);
      } else if (key === 'escape') setRaising(false);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  return (
    <div className="flex w-full flex-col gap-2">
      {raising && range && (
        <div className="pd-pop flex flex-col gap-2 rounded-2xl bg-surface p-3">
          <label className="flex items-center gap-3">
            <span className="sr-only">Raise amount</span>
            <input
              type="range"
              className="flex-1 accent-[rgb(var(--pd-accent))]"
              min={range.min}
              max={range.max}
              step={state.bb}
              value={amount}
              onChange={(event) =>
                setAmount(Math.min(range.max, Math.max(range.min, Number(event.target.value))))
              }
            />
            <output aria-live="polite" className="w-20 text-right text-xl font-bold">
              {formatChips(amount)}
            </output>
          </label>
          <div className="flex flex-wrap justify-center gap-2">
            {presets.map((to, i) => (
              <button
                key={to}
                type="button"
                aria-label={`${presetLabel(to, i)}: ${formatChips(to)} chips`}
                onClick={() => setAmount(to)}
                className={cn(
                  'pd-press cursor-pointer rounded-full px-3 py-1.5 text-sm font-bold',
                  to === amount ? 'bg-primary text-on-primary' : 'bg-raised',
                )}
              >
                {presetLabel(to, i)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        {canFold && (
          <button
            type="button"
            aria-keyshortcuts="F"
            onClick={() => onMove({ act: 'fold' })}
            className="pd-press h-12 flex-1 cursor-pointer rounded-full bg-surface font-bold"
          >
            Fold
          </button>
        )}
        <button
          type="button"
          aria-keyshortcuts="C"
          onClick={() => onMove(owe > 0 ? { act: 'call' } : { act: 'check' })}
          className="pd-press h-12 flex-1 cursor-pointer rounded-full bg-surface font-bold"
        >
          {callLabel}
        </button>
        {range && (
          <button
            type="button"
            aria-keyshortcuts="R"
            onClick={() => {
              if (raising) onMove({ act: 'raise', to: amount });
              else setRaising(true);
            }}
            className="pd-press h-12 flex-1 cursor-pointer truncate rounded-full bg-primary px-2 font-bold text-on-primary"
          >
            {raising ? `${raiseWord} ${formatChips(amount)}` : opening ? 'Bet' : 'Raise'}
          </button>
        )}
      </div>
      <p className="text-center text-xs text-muted">
        Keys: F fold, C {owe > 0 ? 'call' : 'check'}
        {range ? ', R raise (again to confirm)' : ''}. Play chips only.
      </p>
    </div>
  );
}
