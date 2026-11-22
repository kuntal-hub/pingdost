// "Play with friends" from a game in the browser (Phase 43): pick the chat to play in, then the
// chat opens with the invitation dialog for this game. Games live in chats.
import { MessageCircle } from 'lucide-react';
import { Link, useParams } from 'react-router';

import { useConversations, useNames } from '@/chat/hooks';
import { Avatar } from '@/components/avatar';
import { EmptyState } from '@/components/ui/controls';
import { groupName } from '@/features/chats/format';
import { catalogEntry, isPlayableGameType } from '@pingdost/games';

export function PickChatPage() {
  const { game = '' } = useParams();
  const type = isPlayableGameType(game) ? game : 'ludo';
  const { entries, loading } = useConversations();
  const names = useNames();
  const chats = entries.filter(
    // A game for four needs a group.
    ({ conversation: c }) =>
      !c.archived && (c.kind === 'group' || (c.peerUserId && catalogEntry(type).minPlayers <= 2)),
  );
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-4 md:p-6">
      <h1 className="font-display text-2xl font-extrabold">
        Play {catalogEntry(type).name} with friends
      </h1>
      <p className="text-sm text-muted">Where should the invitation go?</p>
      {!loading && chats.length === 0 ? (
        <EmptyState icon={MessageCircle} title="No chats yet">
          <p className="text-muted">
            Add a friend to your circle and start a chat, then invite them to a game.
          </p>
        </EmptyState>
      ) : (
        <ul className="pd-card flex flex-col divide-y divide-border rounded-2xl">
          {chats.map(({ conversation, group }) => {
            const name =
              conversation.kind === 'group'
                ? groupName(group)
                : names.name(conversation.peerUserId ?? '');
            return (
              <li key={conversation.conversationId}>
                <Link
                  to={`/chat/${conversation.conversationId}?startGame=${type}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
                >
                  <Avatar name={name} url={null} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold">{name}</span>
                    <span className="block text-xs text-muted">
                      {conversation.kind === 'group' ? 'Group' : 'Chat'}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
