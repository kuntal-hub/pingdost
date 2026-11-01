// One conversation on the web (REQ §8.1–8.2): a virtualized timeline (react-virtuoso) that
// stays at the newest message and loads older pages when scrolled up, typing, and the composer
// with reply, edit and files. Past the oldest message here, older ones can be asked of the
// phone (ADR 0021). Keyboard: Enter sends, Shift+Enter is a new line, Esc cancels a reply or
// edit, ↑ in an empty composer edits your last message.
import { Info, Paperclip, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { contactName, useContact } from '@/chat/contacts';
import { useConversation, useGroup, useNames, usePresence } from '@/chat/hooks';
import { prefsChanged } from '@/chat/start';
import { useChat, useChatClient } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/menu';
import { api, useSession } from '@/session/session';
import { syncLabel, useHistorySync } from '@/sync/sync-status';
import { previewText, type TimelineItem } from '@pingdost/chat-core';
import { DEFAULT_LIMITS } from '@pingdost/config/public';
import {
  canDeleteForEveryone,
  canEdit,
  type ConversationRecord,
  type MessageRecord,
} from '@pingdost/message-engine';

import { Bubble, type BubbleActions } from './bubble';
import { groupName, groupPictureUri } from './format';
import { AttachmentView } from '../attachments/attachment-view';
import { SendFileDialog } from '../attachments/send-file-dialog';
import { CallButtons } from '../calls/call-buttons';

const MAX_TEXT = 4_000;
const START_INDEX = 1_000_000;
const RULES = {
  editWindowMs: DEFAULT_LIMITS.messageEditWindowSeconds * 1_000,
  deleteWindowMs: DEFAULT_LIMITS.messageDeleteWindowSeconds * 1_000,
};

function failure(error: unknown): string {
  return (error as { code?: string }).code === 'not_allowed'
    ? 'It can no longer be changed (only your own messages, within 24 hours).'
    : 'Something went wrong. Please try again.';
}

function Header({ conversation }: { conversation: ConversationRecord }) {
  const isGroup = conversation.kind === 'group';
  const group = useGroup(isGroup ? conversation.conversationId : undefined);
  const peer = useContact(isGroup ? undefined : conversation.peerUserId);
  const online = usePresence(isGroup ? undefined : conversation.peerUserId);
  const name = isGroup ? groupName(group) : contactName(peer);
  const subtitle = isGroup
    ? group?.left
      ? "You're not a member"
      : `${group?.members.length ?? 0} members`
    : online
      ? 'online'
      : '';
  const infoTo = isGroup
    ? `/group/${conversation.conversationId}`
    : `/contact/${conversation.peerUserId}`;
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2">
      <Link
        to={infoTo}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-1 hover:bg-surface"
      >
        <Avatar
          name={name}
          url={isGroup ? groupPictureUri(group?.avatar) : peer?.avatarUrl}
          size={40}
        />
        <span className="min-w-0">
          <span className="block truncate font-semibold">{name}</span>
          {subtitle && <span className="block text-sm text-muted">{subtitle}</span>}
        </span>
      </Link>
      {/* 1:1 chats only: groups have no call actions (REQ §19.5). */}
      {!isGroup && <CallButtons peerUserId={conversation.peerUserId} />}
      <Link
        to={`/search?c=${conversation.conversationId}`}
        className="rounded p-2 hover:bg-surface"
        aria-label="Search this chat"
      >
        <Search size={18} />
      </Link>
      <Link
        to={infoTo}
        className="rounded p-2 hover:bg-surface"
        aria-label={isGroup ? 'Group info' : 'Contact info'}
      >
        <Info size={18} />
      </Link>
    </header>
  );
}

function Composer({
  conversationId,
  replyTo,
  editing,
  names,
  lastOwn,
  onEdit,
  onDone,
}: {
  conversationId: string;
  replyTo: MessageRecord | undefined;
  editing: MessageRecord | undefined;
  names: ReturnType<typeof useNames>;
  lastOwn: MessageRecord | undefined;
  onEdit: (message: MessageRecord) => void;
  onDone: () => void;
}) {
  const client = useChatClient();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<File>();
  const input = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const trimmed = text.trim();

  useEffect(() => {
    if (editing) setText(editing.body);
    input.current?.focus();
  }, [editing, replyTo]);

  function send() {
    if (!client || trimmed === '') return;
    setText('');
    setError(undefined);
    void client.setTyping(conversationId, false).catch(() => undefined);
    const done = onDone;
    if (editing) {
      if (trimmed !== editing.body.trim()) {
        client.editMessage(editing.messageId, trimmed).catch((e: unknown) => setError(failure(e)));
      }
      done();
      return;
    }
    client
      .sendText(conversationId, trimmed, replyTo ? { replyTo: replyTo.messageId } : {})
      .catch(() => setError('The message could not be saved. Try again.'));
    done();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && (editing || replyTo)) {
      event.preventDefault();
      if (editing) setText('');
      onDone();
    } else if (event.key === 'ArrowUp' && text === '' && lastOwn && !editing) {
      event.preventDefault();
      onEdit(lastOwn);
    }
  }

  const context = editing ?? replyTo;
  return (
    <div className="border-t border-border p-3">
      {context && (
        <div className="mb-2 flex items-center gap-2 rounded-md border-l-4 border-primary bg-surface px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-primary">
              {editing
                ? 'Editing message'
                : `Replying to ${context.senderUserId === names.selfUserId ? 'yourself' : names.name(context.senderUserId)}`}
            </div>
            <div className="truncate text-sm text-muted">
              {editing
                ? 'Shown as “edited” on every device. The earlier text is not kept.'
                : previewText(context, names)}
            </div>
          </div>
          <button
            type="button"
            aria-label={editing ? 'Cancel editing (Esc)' : 'Cancel reply (Esc)'}
            onClick={() => {
              if (editing) setText('');
              onDone();
            }}
            className="rounded p-2 hover:bg-border/40"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={filePicker}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) setPicked(file);
          }}
        />
        <button
          type="button"
          aria-label="Send a photo, video or file"
          disabled={!client || editing !== undefined}
          onClick={() => filePicker.current?.click()}
          className="mb-1 rounded p-2 hover:bg-surface disabled:opacity-50"
        >
          <Paperclip size={20} />
        </button>
        <Textarea
          ref={input}
          aria-label={editing ? 'Edited message' : 'Message'}
          placeholder="Message"
          rows={1}
          maxLength={MAX_TEXT}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (client && !editing) {
              void client
                .setTyping(conversationId, event.target.value.trim() !== '')
                .catch(() => undefined);
            }
          }}
          onBlur={() => void client?.setTyping(conversationId, false).catch(() => undefined)}
          onKeyDown={keyDown}
          className="max-h-40 field-sizing-content"
        />
        <Button onClick={send} disabled={!client || trimmed === ''}>
          {editing ? 'Save' : 'Send'}
        </Button>
      </div>
      <SendFileDialog
        file={picked}
        conversationId={conversationId}
        replyTo={replyTo?.messageId}
        onClose={(sent) => {
          setPicked(undefined);
          if (sent) onDone();
        }}
      />
    </div>
  );
}

/** Above the oldest message here: older messages of this chat, from the phone. */
function OlderFromPhone({
  conversationId,
  oldest,
}: {
  conversationId: string;
  oldest: MessageRecord | undefined;
}) {
  const client = useChatClient();
  const sync = useHistorySync();
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string>();
  const mine = sync?.conversationId === conversationId;
  const busy =
    sync?.state === 'requesting' ||
    sync?.state === 'syncing' ||
    sync?.state === 'phone_offline' ||
    sync?.state === 'offline';
  return (
    <div className="flex flex-col items-center gap-1 py-3">
      <Button
        variant="ghost"
        className="min-h-9 text-sm"
        disabled={!client || busy}
        onClick={() => {
          setError(undefined);
          setAsked(true);
          client
            ?.loadOlderFromPhone(
              conversationId,
              oldest ? { sortAt: oldest.sortAt, messageId: oldest.messageId } : null,
            )
            .catch((e: unknown) =>
              setError(e instanceof Error ? e.message : 'Your phone could not be asked.'),
            );
        }}
      >
        Load older messages from phone
      </Button>
      {asked && mine && sync && <p className="text-xs text-muted">{syncLabel(sync)}</p>}
      {busy && !mine && <p className="text-xs text-muted">Wait until the history sync finishes.</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function ChatView() {
  const { conversationId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useChatClient();
  const names = useNames();
  const deviceId = useSession((state) => state.device?.deviceId);
  const status = useChat((state) => state.status);
  const privacy = useChat((state) => state.privacy);
  const blockedIds = useChat((state) => state.blocked);
  const [conversation, setConversation] = useState<ConversationRecord>();
  const { items, loaded, loadOlder, loadUntil, typing, complete } = useConversation(conversationId);
  const isGroup = conversation?.kind === 'group';
  const group = useGroup(isGroup ? conversationId : undefined);
  const peerUserId = isGroup ? undefined : conversation?.peerUserId;
  const peer = useContact(peerUserId);
  const blocked = peerUserId !== undefined && blockedIds.includes(peerUserId);
  const left = isGroup && group?.left === true;
  const [replyTo, setReplyTo] = useState<MessageRecord>();
  const [editing, setEditing] = useState<MessageRecord>();
  const [deleting, setDeleting] = useState<MessageRecord>();
  const [highlight, setHighlight] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const list = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    if (!client) return;
    void client.getConversation(conversationId).then(setConversation, () => undefined);
    setReplyTo(undefined);
    setEditing(undefined);
  }, [client, conversationId]);

  // Presence of the open chat's peer only (when they share it).
  useEffect(() => {
    if (!client || !peerUserId) return;
    void client.watchPresence([peerUserId]).catch(() => undefined);
    return () => void client.watchPresence([]).catch(() => undefined);
  }, [client, peerUserId]);

  // Reading the chat clears its unread count and sends read receipts (if on).
  useEffect(() => {
    if (!client || document.visibilityState !== 'visible') return;
    void client.markRead(conversationId).catch(() => undefined);
  }, [client, conversationId, items.length]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible' && client)
        void client.markRead(conversationId).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [client, conversationId]);

  // Keep the scroll position when older pages are prepended.
  const firstKey = useRef<string | undefined>(undefined);
  const firstIndex = useRef(START_INDEX);
  const firstItemIndex = useMemo(() => {
    const previous = firstKey.current;
    if (previous !== undefined) {
      const moved = items.findIndex((item) => item.key === previous);
      if (moved > 0) firstIndex.current -= moved;
    }
    firstKey.current = items[0]?.key;
    return firstIndex.current;
  }, [items]);
  useEffect(() => {
    firstKey.current = undefined;
    firstIndex.current = START_INDEX;
  }, [conversationId]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const jumpTo = useCallback(
    async (messageId: string) => {
      if (!(await loadUntil(messageId))) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const index = itemsRef.current.findIndex((item) => item.key === messageId);
      if (index < 0) return;
      list.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' });
      setHighlight(messageId);
      setTimeout(
        () => setHighlight((current) => (current === messageId ? undefined : current)),
        1_500,
      );
    },
    [loadUntil],
  );
  const focus = params.get('m');
  const hasItems = items.length > 0;
  useEffect(() => {
    // Once per requested message, when the first page is there.
    if (focus && hasItems) void jumpTo(focus);
  }, [focus, hasItems, jumpTo]);

  const now = Date.now();
  const actions: BubbleActions = {
    reply: (message) => {
      setEditing(undefined);
      setReplyTo(message);
    },
    edit: (message) => {
      setReplyTo(undefined);
      setEditing(message);
    },
    react: (message, emoji) => {
      client?.react(message.messageId, emoji).catch((e: unknown) => setNotice(failure(e)));
    },
    info: (message) => void navigate(`/message/${message.messageId}`),
    remove: setDeleting,
    retry: (message) => void client?.retry(message.messageId).catch(() => undefined),
    jumpTo: (messageId) => void jumpTo(messageId),
    canEdit: (message) => canEdit(message, names.selfUserId, RULES, now),
  };
  const lastOwn = [...items]
    .reverse()
    .find(
      (item): item is Extract<TimelineItem, { type: 'message' }> =>
        item.type === 'message' &&
        item.message.senderDeviceId === deviceId &&
        canEdit(item.message, names.selfUserId, RULES, now),
    )?.message;

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center text-muted">Opening the chat…</div>
    );
  }
  const oldestMessage = items.find(
    (item): item is Extract<TimelineItem, { type: 'message' }> => item.type === 'message',
  )?.message;
  const oldestHeader = () => (
    <OlderFromPhone conversationId={conversationId} oldest={oldestMessage} />
  );
  const name = isGroup ? groupName(group) : contactName(peer);
  const readReceipts = privacy?.readReceipts ?? false;

  return (
    <div className="flex h-full flex-col">
      <Header conversation={conversation} />
      {status !== 'online' && (
        <p className="border-b border-border bg-surface px-4 py-1 text-sm text-muted" role="status">
          {status === 'connecting'
            ? 'Connecting…'
            : 'Offline. Messages you write wait here and go out when you are back.'}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {items.length === 0 ? (
          <div className="mx-auto mt-10 max-w-md px-6 text-center text-muted">
            <p>
              {isGroup
                ? `Messages in ${name} are end-to-end encrypted for its members. No one else, not even PingDost, can read them.`
                : `Messages with ${name} are end-to-end encrypted. No one else, not even PingDost, can read them.`}
            </p>
            {complete && <OlderFromPhone conversationId={conversationId} oldest={undefined} />}
          </div>
        ) : (
          <Virtuoso
            ref={list}
            data={items}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={items.length - 1}
            followOutput="smooth"
            startReached={() => void loadOlder()}
            computeItemKey={(_, item) => item.key}
            components={complete ? { Header: oldestHeader } : {}}
            itemContent={(_, item) =>
              item.type === 'day' ? (
                <div className="my-3 flex justify-center">
                  <span className="rounded-full bg-surface px-3 py-1 text-xs text-muted">
                    {item.label}
                  </span>
                </div>
              ) : (
                <Bubble
                  message={item.message}
                  quoted={item.message.replyTo ? loaded.get(item.message.replyTo) : undefined}
                  names={names}
                  isGroup={isGroup}
                  online={status === 'online'}
                  readReceipts={readReceipts}
                  highlighted={highlight === item.message.messageId}
                  readOnly={blocked || left}
                  actions={actions}
                  attachment={
                    item.message.attachment ? <AttachmentView message={item.message} /> : undefined
                  }
                />
              )
            }
            className="h-full"
          />
        )}
      </div>
      {typing && !blocked && (
        <p aria-live="polite" className="px-4 pb-1 text-sm text-muted">
          {name} is typing…
        </p>
      )}
      {notice && (
        <p role="alert" className="px-4 pb-1 text-sm text-danger">
          {notice}
        </p>
      )}
      {left ? (
        <p className="border-t border-border p-4 text-center text-muted">
          You&apos;re no longer a member of this group. You can read what is here, but not send.
        </p>
      ) : blocked && peerUserId ? (
        <div className="flex items-center justify-center gap-3 border-t border-border p-4">
          <span className="text-muted">You blocked {name}.</span>
          <Button
            variant="secondary"
            onClick={() =>
              void api.security.unblock(peerUserId).then(() => {
                useChat.setState((state) => ({
                  blocked: state.blocked.filter((id) => id !== peerUserId),
                }));
                prefsChanged();
              })
            }
          >
            Unblock
          </Button>
        </div>
      ) : (
        <Composer
          conversationId={conversationId}
          replyTo={replyTo}
          editing={editing}
          names={names}
          lastOwn={lastOwn}
          onEdit={(message) => actions.edit(message)}
          onDone={() => {
            setReplyTo(undefined);
            setEditing(undefined);
          }}
        />
      )}
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title="Delete this message?"
      >
        <div className="flex flex-col gap-2">
          <Button
            variant="danger"
            onClick={() => {
              if (deleting) void client?.deleteForMe([deleting.messageId]);
              setDeleting(undefined);
            }}
          >
            Delete for me
          </Button>
          <p className="text-sm text-muted">Removes it from this browser only.</p>
          {deleting && canDeleteForEveryone(deleting, names.selfUserId, RULES, now) && !left && (
            <>
              <Button
                variant="danger"
                onClick={() => {
                  client
                    ?.deleteForEveryone(deleting.messageId)
                    .catch((e: unknown) => setNotice(failure(e)));
                  setDeleting(undefined);
                }}
              >
                Delete for everyone
              </Button>
              <p className="text-sm text-muted">
                Asks every copy to be removed. It can&apos;t erase screenshots, exports or copies
                already saved elsewhere.
              </p>
            </>
          )}
          <Button variant="secondary" onClick={() => setDeleting(undefined)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
