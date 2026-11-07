// The chat list (REQ §8.1): pinned chats first, then by latest activity; archived chats in their
// own folder; unread counts; mute, pin, archive and delete from each row's menu. Filters narrow it
// to unread chats or groups. While history arrives from the phone, a banner shows its progress
// (ADR 0021).
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  BellOff,
  File,
  Image,
  Mic,
  MoreVertical,
  Pin,
  PinOff,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';

import { contactName, useContact } from '@/chat/contacts';
import { useConversations, useNames, type ChatListEntry } from '@/chat/hooks';
import { useChatClient } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button, IconButton } from '@/components/ui/button';
import { Chip, EmptyState, SkeletonRows } from '@/components/ui/controls';
import { Dialog, Menu } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { SyncBanner } from '@/sync/sync-status';
import { attachmentType, previewText, type AttachmentKind } from '@pingdost/chat-core';
import { MUTED_FOREVER } from '@pingdost/message-engine';

import { groupName, groupPictureUri, listTime } from './format';

type Filter = 'all' | 'unread' | 'groups';

const ATTACHMENT_ICONS: Record<AttachmentKind, LucideIcon> = {
  image: Image,
  video: Video,
  audio: Mic,
  file: File,
};

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
  const preview = last ? previewText(last, names) : 'Say hi';
  const mine = last?.direction === 'out' ? 'You: ' : '';
  const id = conversation.conversationId;
  const pinned = conversation.pinnedAt !== null;
  const unread = conversation.unreadCount;
  const AttachmentIcon =
    last?.kind === 'attachment' ? ATTACHMENT_ICONS[attachmentType(last).kind] : undefined;

  return (
    <li className="group relative">
      <NavLink
        to={`/chat/${id}`}
        className={({ isActive }) =>
          cn(
            'pd-row flex items-center gap-3 rounded-xl px-2 py-2 pr-10 transition-colors duration-150 hover:bg-raised',
            isActive && 'bg-accent/15 hover:bg-accent/15',
          )
        }
      >
        <span className="transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-105 group-hover:-rotate-3">
          <Avatar
            name={name}
            url={conversation.kind === 'group' ? groupPictureUri(group?.avatar) : peer?.avatarUrl}
            size={52}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-bold">{name}</span>
            {pinned && <Pin aria-label="Pinned" size={14} className="shrink-0 text-muted" />}
            {muted && <BellOff aria-label="Muted" size={14} className="shrink-0 text-muted" />}
            <span
              className={cn(
                'ml-auto shrink-0 text-xs',
                unread > 0 && !muted ? 'font-bold text-accent' : 'text-muted',
              )}
            >
              {listTime(conversation.updatedAt)}
            </span>
          </span>
          <span className="flex items-center gap-1">
            {AttachmentIcon && (
              <AttachmentIcon aria-hidden size={14} className="shrink-0 text-muted" />
            )}
            <span
              className={cn(
                'truncate text-sm',
                unread > 0 ? 'font-semibold text-foreground' : 'text-muted',
              )}
            >
              {group?.left ? "You're not a member" : `${mine}${preview}`}
            </span>
            {unread > 0 && (
              <span
                key={unread}
                aria-label={`${unread} unread`}
                className={cn(
                  'pd-pop ml-auto min-w-6 shrink-0 rounded-full px-1.5 text-center text-xs leading-5 font-bold',
                  muted ? 'bg-raised text-muted' : 'bg-secondary text-on-secondary',
                )}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </span>
        </span>
      </NavLink>
      <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Menu
          label={`Actions for ${name}`}
          trigger={
            <button
              type="button"
              className="pd-press cursor-pointer rounded-full p-2 text-muted hover:bg-border"
            >
              <MoreVertical size={16} />
            </button>
          }
          items={[
            {
              label: pinned ? 'Unpin' : 'Pin',
              icon: pinned ? PinOff : Pin,
              onSelect: () => void client?.setPinned(id, !pinned),
            },
            {
              label: muted ? 'Unmute' : 'Mute',
              icon: muted ? Bell : BellOff,
              onSelect: () => void client?.setMuted(id, muted ? null : MUTED_FOREVER),
            },
            {
              label: conversation.archived ? 'Unarchive' : 'Archive',
              icon: conversation.archived ? ArchiveRestore : Archive,
              onSelect: () => void client?.setArchived(id, !conversation.archived),
            },
            {
              label: 'Delete chat…',
              icon: Trash2,
              destructive: true,
              onSelect: () => onDelete(entry),
            },
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
  const [filter, setFilter] = useState<Filter>('all');
  const [deleting, setDeleting] = useState<ChatListEntry>();
  const [error, setError] = useState<string>();

  const inFolder = useMemo(
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
  const shown = inFolder.filter((e) =>
    filter === 'unread'
      ? e.conversation.unreadCount > 0
      : filter === 'groups'
        ? e.conversation.kind === 'group'
        : true,
  );
  const unreadChats = inFolder.filter((e) => e.conversation.unreadCount > 0).length;
  const archivedCount = entries.filter((e) => e.conversation.archived).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-4 pt-4 pb-2">
        {archived && (
          <IconButton aria-label="Back to chats" onClick={() => setArchived(false)}>
            <ArrowLeft size={20} />
          </IconButton>
        )}
        <h1 className="flex-1 font-display text-3xl font-extrabold">
          {archived ? 'Archived' : 'Chats'}
        </h1>
        <IconButton asChild aria-label="Search messages (Ctrl+K)">
          <Link to="/search">
            <Search size={20} />
          </Link>
        </IconButton>
        <IconButton asChild aria-label="New group">
          <Link to="/new-group">
            <Users size={20} />
          </Link>
        </IconButton>
        <IconButton asChild tone="brand" aria-label="New chat (Alt+N)">
          <Link to="/new">
            <Plus size={22} />
          </Link>
        </IconButton>
      </div>
      <SyncBanner />
      {!archived && (
        <div
          className="flex gap-2 overflow-x-auto px-4 py-2"
          role="group"
          aria-label="Filter chats"
        >
          <Chip label="All" selected={filter === 'all'} onClick={() => setFilter('all')} />
          <Chip
            label="Unread"
            selected={filter === 'unread'}
            count={unreadChats}
            onClick={() => setFilter('unread')}
          />
          <Chip label="Groups" selected={filter === 'groups'} onClick={() => setFilter('groups')} />
          {archivedCount > 0 && (
            <button
              type="button"
              onClick={() => setArchived(true)}
              className="pd-press ml-auto flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-sm font-bold text-muted hover:bg-raised"
            >
              <Archive aria-hidden size={16} /> {archivedCount}
              <span className="sr-only"> archived</span>
            </button>
          )}
        </div>
      )}
      {loading ? (
        <SkeletonRows />
      ) : (
        <ul className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Conversations">
          {shown.length === 0 ? (
            <li>
              {archived ? (
                <EmptyState icon={Archive} title="Nothing archived" />
              ) : filter === 'unread' ? (
                <EmptyState icon={Sparkles} title="All caught up">
                  No unread messages.
                </EmptyState>
              ) : filter === 'groups' ? (
                <EmptyState icon={Users} title="No groups yet">
                  Start one with the button above.
                </EmptyState>
              ) : (
                <EmptyState icon={Sparkles} title="No chats yet">
                  Your recent chats arrive from your phone, or start one with the + button.
                </EmptyState>
              )}
            </li>
          ) : (
            shown.map((entry) => (
              <Row key={entry.conversation.conversationId} entry={entry} onDelete={setDeleting} />
            ))
          )}
        </ul>
      )}
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title="Delete this chat from this browser?"
        description="Its messages are removed from this browser only. Your phone and the other people keep their copies."
      >
        {error && <p className="font-medium text-danger">{error}</p>}
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
