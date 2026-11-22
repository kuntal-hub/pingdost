// A game invitation in a chat (Phases 42–43, ADR 0049): which game, how it stands, and a button to
// join, play or watch. Its line updates as the game's events arrive.
import { useNavigate } from 'react-router';

import { cn } from '@/lib/cn';
import type { Names } from '@pingdost/chat-core';
import { gameTypeLabel } from '@pingdost/games';
import { readGameCard, type MessageRecord } from '@pingdost/message-engine';

import { gameIconFor } from './game-icons';
import { useGameSummary } from './network';

export function GameCard({
  message,
  names,
  outgoing,
}: {
  message: MessageRecord;
  names: Names;
  outgoing: boolean;
}) {
  const navigate = useNavigate();
  const card = readGameCard(message.body);
  const summary = useGameSummary(card?.gameId ?? message.messageId, (id) => names.name(id));
  if (!card) return <span>Game</span>;
  const Glyph = gameIconFor(card.type);
  const title = gameTypeLabel(card.type);
  const action =
    summary?.state === 'invite'
      ? 'Join'
      : summary?.live && summary.playing
        ? summary.state === 'your-turn'
          ? 'Play'
          : 'Open'
        : summary?.live
          ? 'Watch'
          : 'View';
  return (
    <div className="flex min-w-56 items-center gap-3 py-1">
      <span
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-xl',
          outgoing ? 'bg-on-primary/15' : 'bg-accent/15 text-accent',
        )}
      >
        <Glyph aria-hidden size={24} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block font-bold">{title}</span>
        <span className={cn('block truncate text-sm', outgoing ? 'opacity-85' : 'text-muted')}>
          {summary?.text ?? 'Loading…'}
        </span>
      </span>
      <button
        type="button"
        aria-label={`${action} ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          void navigate(
            `/games/play/${card.gameId}${summary?.state === 'invite' ? '?join=1' : ''}`,
          );
        }}
        className={cn(
          'pd-press shrink-0 cursor-pointer rounded-full px-3 py-1.5 text-sm font-bold',
          outgoing ? 'bg-on-primary text-primary' : 'bg-primary text-on-primary',
        )}
      >
        {action}
      </button>
    </div>
  );
}
