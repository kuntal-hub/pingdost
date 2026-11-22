// Games with friends on the Games page (Phase 42, ADR 0049): games waiting for you, games in
// play, invitations, and friends online to invite (circle members who share their presence).
// Inviting opens the 1:1 chat with the game dialog; the game itself lives in that chat.
import { Send } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';

import { useConversations, useNames } from '@/chat/hooks';
import { useChat, useChatClient } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { gameTypeLabel } from '@pingdost/games';

import { gameIconFor } from './game-icons';
import { useGameList, type GameEntry } from './network';

function GameRow({ entry, chat }: { entry: GameEntry; chat: string }) {
  const { summary } = entry;
  const Glyph = gameIconFor(entry.record.gameType);
  const title = gameTypeLabel(entry.record.gameType);
  const action =
    summary.state === 'invite'
      ? 'Join'
      : summary.state === 'your-turn'
        ? 'Play'
        : summary.live
          ? 'Open'
          : 'View';
  return (
    <li className="pd-card flex items-center gap-3 rounded-2xl p-3">
      <span
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-xl',
          summary.state === 'your-turn' ? 'bg-primary text-on-primary' : 'bg-raised text-accent',
        )}
      >
        <Glyph aria-hidden size={24} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-bold">
          {title} · {chat}
        </span>
        <span className="block truncate text-sm text-muted">{summary.text}</span>
      </span>
      <Button asChild variant={summary.state === 'your-turn' ? 'primary' : 'secondary'}>
        <Link
          to={`/games/play/${entry.record.gameId}${summary.state === 'invite' ? '?join=1' : ''}`}
        >
          {action}
        </Link>
      </Button>
    </li>
  );
}

export function FriendGames() {
  const names = useNames();
  const games = useGameList((id) => names.name(id));
  const { entries } = useConversations();
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const { conversation, group } of entries) {
      map.set(
        conversation.conversationId,
        group?.name ?? (conversation.peerUserId ? names.name(conversation.peerUserId) : 'Chat'),
      );
    }
    return map;
  }, [entries, names]);
  const yours = games.filter((g) => g.summary.state === 'your-turn');
  const playing = games.filter(
    (g) => g.summary.live && g.summary.playing && g.summary.state !== 'your-turn',
  );
  const invites = games.filter((g) => g.summary.state === 'invite');
  const sections: [string, GameEntry[]][] = [
    ['Your turn', yours],
    ['Playing', playing],
    ['Invitations', invites],
  ];
  if (games.length === 0) return null;
  return (
    <>
      {sections
        .filter(([, list]) => list.length > 0)
        .map(([title, list]) => (
          <section key={title} className="flex flex-col gap-2">
            <h2 className="font-bold text-muted">{title}</h2>
            <ul className="flex flex-col gap-2">
              {list.map((entry) => (
                <GameRow
                  key={entry.record.gameId}
                  entry={entry}
                  chat={titles.get(entry.record.conversationId) ?? 'Chat'}
                />
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}

export function FriendsOnline() {
  const client = useChatClient();
  const navigate = useNavigate();
  const names = useNames();
  const circle = useChat((state) => state.circle);
  const presence = useChat((state) => state.presence);
  const members = useMemo(() => circle?.members ?? [], [circle]);
  const ids = members.map((m) => m.userId).join(',');

  // Watched while this page is open, beside the open chat's peer.
  useEffect(() => {
    if (!client || ids === '') return;
    void client.watchPresence(ids.split(','), 'games').catch(() => undefined);
    return () => void client.watchPresence([], 'games').catch(() => undefined);
  }, [client, ids]);

  const online = members.filter((m) => presence[m.userId]);
  if (members.length === 0) return null;

  async function invite(userId: string) {
    if (!client) return;
    const { conversationId } = await client.openDirectConversation(userId);
    void navigate(`/chat/${conversationId}?startGame=1`);
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-bold text-muted">Friends online</h2>
      {online.length === 0 ? (
        <p className="text-sm text-muted">
          Nobody in your circle is online right now (only friends who share when they are online
          show here). You can still invite anyone from a chat.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {online.map((member) => (
            <li key={member.userId} className="pd-card flex items-center gap-3 rounded-2xl p-3">
              <Avatar name={names.name(member.userId)} online size={40} />
              <span className="min-w-0 flex-1 truncate font-bold">{names.name(member.userId)}</span>
              <Button variant="secondary" onClick={() => void invite(member.userId)}>
                <Send aria-hidden size={16} />
                Invite
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
