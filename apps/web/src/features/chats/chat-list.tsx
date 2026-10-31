// The chat list (REQ §8.1): pinned chats first, then by latest activity; archived chats in their
// own folder; unread counts; mute, pin, archive and delete from each row's menu. While history
// arrives from the phone, a banner shows its progress (ADR 0021).
import { BellOff, MoreVertical, Pin, Plus, Search, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';

import { contactName, useContact } from '@/chat/contacts';
import { useConversations, useNames, type ChatListEntry } from '@/chat/hooks';
import { useChatClient } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, Menu } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { SyncBanner } from '@/sync/sync-status';
import { previewText } from '@pingdost/chat-core';
import { MUTED_FOREVER } from '@pingdost/message-engine';

import { groupName, groupPictureUri, listTime } from './format';

function Row({
  entry,
  onDelete,
}: {
  entry: ChatListEntry;
  onDelete: (entry: ChatListEntry) => void;
}) {
  const client = useChatClient();
  const names = useNames();
  const { conversation, last, group } = entry;
  const peer = useContact(conversation.kind === 'direct' ? conversation.peerUserId : undefined);
  const name = conversation.kind === 'group' ? groupName(group) : contactName(peer);
  const muted = conversation.mutedUntil !== null && conversation.mutedUntil > Date.now();
  const preview = last ? previewText(last, names) : '';
  const mine = last?.direction === 'out' ? 'You: ' : '';
  const id = conversation.conversationId;

  return (
    <li className="group relative">
      <NavLink
        to={`/chat/${id}`}
        className={({ isActive }) =>
          cn(
            'flex min-h-16 items-center gap-3 rounded-md px-3 py-2 pr-10 hover:bg-surface',
            isActive && 'bg-primary/10',
          )
        }
      >
        <Avatar
          name={name}
          url={conversation.kind === 'group' ? groupPictureUri(group?.avatar) : peer?.avatarUrl}
          size={44}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold">{name}</span>
            {conversation.pinnedAt !== null && (
              <Pin aria-label="Pinned" size={14} className="text-muted" />
            )}
            {muted && <BellOff aria-label="Muted" size={14} className="text-muted" />}
            <span className="ml-auto shrink-0 text-xs text-muted">
              {listTime(conversation.updatedAt)}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="truncate text-sm text-muted">
              {group?.left ? "You're not a member" : `${mine}${preview}`}
            </span>
            {conversation.unreadCount > 0 && (
              <span
                aria-label={`${conversation.unreadCount} unread`}
                className="ml-auto min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-center text-xs font-semibold text-on-primary"
              >
                {conversation.unreadCount}
              </span>
            )}
          </span>
        </span>
      </NavLink>
      <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <Menu
          label={`Actions for ${name}`}
          trigger={
            <button type="button" className="rounded p-2 text-muted hover:bg-border/40">
              <MoreVertical size={16} />
            </button>
          }
          items={[
            {
              label: conversation.pinnedAt !== null ? 'Unpin' : 'Pin',
              onSelect: () => void client?.setPinned(id, conversation.pinnedAt === null),
            },
            {
              label: muted ? 'Unmute' : 'Mute',
              onSelect: () => void client?.setMuted(id, muted ? null : MUTED_FOREVER),
            },
            {
              label: conversation.archived ? 'Unarchive' : 'Archive',
              onSelect: () => void client?.setArchived(id, !conversation.archived),
            },
            { label: 'Delete chat…', destructive: true, onSelect: () => onDelete(entry) },
          ]}
        />
      </div>
    </li>
  );
}

export function ChatList() {
  const navigate = useNavigate();
  const client = useChatClient();
  const { entries, loading } = useConversations();
  const [archived, setArchived] = useState(false);
  const [deleting, setDeleting] = useState<ChatListEntry>();
  const [error, setError] = useState<string>();

  const shown = useMemo(
    () =>
      entries
        .filter((e) => e.conversation.archived === archived)
        .sort(
          (a, b) =>
            (b.conversation.pinnedAt ?? 0) - (a.conversation.pinnedAt ?? 0) ||
            b.conversation.updatedAt - a.conversation.updatedAt,
        ),
    [entries, archived],
  );
  const archivedCount = entries.filter((e) => e.conversation.archived).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <h2 className="flex-1 text-lg font-semibold">{archived ? 'Archived' : 'Chats'}</h2>
        <Link
          to="/search"
          className="rounded p-2 hover:bg-surface"
          aria-label="Search messages (Ctrl+K)"
        >
          <Search size={18} />
        </Link>
        <Link to="/new-group" className="rounded p-2 hover:bg-surface" aria-label="New group">
          <Users size={18} />
        </Link>
        <Link to="/new" className="rounded p-2 hover:bg-surface" aria-label="New chat">
          <Plus size={18} />
        </Link>
      </div>
      <SyncBanner />
      {(archivedCount > 0 || archived) && (
        <button
          type="button"
          onClick={() => setArchived((a) => !a)}
          className="mx-3 mt-2 rounded-md px-3 py-2 text-left text-sm text-primary hover:bg-surface"
        >
          {archived ? '← Back to chats' : `Archived (${archivedCount})`}
        </button>
      )}
      <ul className="flex-1 overflow-y-auto p-2" aria-label="Conversations">
        {loading ? (
          <li className="p-4 text-muted">Loading chats…</li>
        ) : shown.length === 0 ? (
          <li className="p-4 text-muted">
            {archived
              ? 'No archived chats.'
              : 'No chats here yet. Your recent chats arrive from your phone, or start one with the + button.'}
          </li>
        ) : (
          shown.map((entry) => (
            <Row key={entry.conversation.conversationId} entry={entry} onDelete={setDeleting} />
          ))
        )}
      </ul>
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title="Delete this chat from this browser?"
        description="Its messages are removed from this browser only. Your phone and the other people keep their copies."
      >
        {error && <p className="text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(undefined)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const id = deleting?.conversation.conversationId;
              if (!client || !id) return;
              client.deleteConversation(id).then(
                () => {
                  setDeleting(undefined);
                  setError(undefined);
                  void navigate('/');
                },
                (caught: unknown) =>
                  setError(
                    (caught as { code?: string }).code === 'not_allowed'
                      ? 'Leave the group before deleting its chat.'
                      : 'Could not delete the chat.',
                  ),
              );
            }}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
