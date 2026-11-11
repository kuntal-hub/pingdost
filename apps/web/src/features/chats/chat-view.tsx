// One conversation on the web (REQ §8.1–8.2): a virtualized timeline (react-virtuoso) that
// stays at the newest message and loads older pages when scrolled up, typing, and the composer
// with reply, edit and files. Past the oldest message here, older ones can be asked of the
// phone (ADR 0021). Keyboard: Enter sends, Shift+Enter is a new line, Esc cancels a reply or
// edit, ↑ in an empty composer edits your last message.
import {
  ArrowDown,
  ArrowLeft,
  Check,
  Copy,
  Forward,
  Info,
  Lock,
  Paperclip,
  Pencil,
  Reply,
  Search,
  SendHorizontal,
  Smile,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { contactName, useContact } from '@/chat/contacts';
import { useConversation, useGroup, useNames, usePresence } from '@/chat/hooks';
import { prefsChanged } from '@/chat/start';
import { useChat, useChatClient, useCircleState } from '@/chat/store';
import { Avatar } from '@/components/avatar';
import { Button, IconButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { Dialog } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { api, useSession } from '@/session/session';
import { syncLabel, useHistorySync } from '@/sync/sync-status';
import {
  copyable,
  copyText,
  deleteForEveryoneCheck,
  forwardable,
  isAtEnd,
  newestMark,
  previewText,
  selectedMessages,
  toggleSelected,
  unseenCount,
  unseenLabel,
  type SeenMark,
  type TimelineItem,
} from '@pingdost/chat-core';
import { insertAt } from '@pingdost/chat-core/emoji';
import { DEFAULT_LIMITS } from '@pingdost/config/public';
import {
  canDeleteForEveryone,
  canEdit,
  type ConversationRecord,
  type MessageRecord,
} from '@pingdost/message-engine';

import { Bubble, type BubbleActions } from './bubble';
import { EmojiPanel } from './emoji-panel';
import { groupName, groupPictureUri } from './format';
import { ForwardDialog } from './forward-dialog';
import { AttachmentView } from '../attachments/attachment-view';
import { SendFileDialog } from '../attachments/send-file-dialog';
import { CallButtons } from '../calls/call-buttons';
import { CircleAction } from '../circle/circle-action';

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

/** Messages this far apart start a new run, even from the same sender. */
const RUN_GAP_MS = 5 * 60_000;

/** Whether a neighbor continues the same sender's run of messages. */
function continuesRun(me: MessageRecord, other: TimelineItem | undefined): boolean {
  if (other?.type !== 'message' || other.message.kind === 'system') return false;
  return (
    other.message.senderUserId === me.senderUserId &&
    other.message.direction === me.direction &&
    Math.abs(other.message.sortAt - me.sortAt) < RUN_GAP_MS
  );
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
    <header className="pd-floating absolute inset-x-3 top-3 z-10 flex items-center gap-1 rounded-2xl p-1.5">
      <IconButton asChild aria-label="Back to chats" className="md:hidden">
        <Link to="/">
          <ArrowLeft size={20} />
        </Link>
      </IconButton>
      <Link
        to={infoTo}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 transition-colors hover:bg-raised"
      >
        <Avatar
          name={name}
          url={isGroup ? groupPictureUri(group?.avatar) : peer?.avatarUrl}
          size={40}
          online={online}
        />
        <span className="min-w-0">
          <span className="block truncate font-bold">{name}</span>
          {subtitle && (
            <span
              className={cn('block text-xs font-semibold', online ? 'text-success' : 'text-muted')}
            >
              {subtitle}
            </span>
          )}
        </span>
      </Link>
      {/* 1:1 chats only: groups have no call actions (REQ §19.5). */}
      {!isGroup && <CallButtons peerUserId={conversation.peerUserId} />}
      <IconButton asChild aria-label="Search this chat">
        <Link to={`/search?c=${conversation.conversationId}`}>
          <Search size={20} />
        </Link>
      </IconButton>
      <IconButton asChild aria-label={isGroup ? 'Group info' : 'Contact info'}>
        <Link to={infoTo}>
          <Info size={20} />
        </Link>
      </IconButton>
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
  onSent,
}: {
  conversationId: string;
  replyTo: MessageRecord | undefined;
  editing: MessageRecord | undefined;
  names: ReturnType<typeof useNames>;
  lastOwn: MessageRecord | undefined;
  onEdit: (message: MessageRecord) => void;
  onDone: () => void;
  /** A message went out: the chat jumps to the newest message (Phase 36). */
  onSent: () => void;
}) {
  const client = useChatClient();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<File>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  // Where an emoji goes: the field's selection when it was last left.
  const selection = useRef({ start: 0, end: 0 });
  const trimmed = text.trim();

  function changeText(next: string) {
    setText(next);
    if (client && !editing) {
      void client.setTyping(conversationId, next.trim() !== '').catch(() => undefined);
    }
  }

  function insertEmoji(emoji: string) {
    const next = insertAt(text, selection.current, emoji);
    if (next.text.length > MAX_TEXT) return;
    changeText(next.text);
    selection.current = { start: next.caret, end: next.caret };
    requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret));
  }

  function closeEmoji() {
    setEmojiOpen(false);
    const { start, end } = selection.current;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(start, end);
    });
  }

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
    selection.current = { start: 0, end: 0 };
    onSent();
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
    <div className="p-3 pt-1">
      {context && (
        <div className="pd-rise mb-2 flex items-center gap-3 rounded-xl border-l-4 border-accent bg-surface py-2 pr-1 pl-3">
          {editing ? (
            <Pencil aria-hidden size={18} className="shrink-0 text-accent" />
          ) : (
            <Reply aria-hidden size={18} className="shrink-0 text-accent" />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-bold text-accent">
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
          <IconButton
            aria-label={editing ? 'Cancel editing (Esc)' : 'Cancel reply (Esc)'}
            onClick={() => {
              if (editing) setText('');
              onDone();
            }}
          >
            <X size={18} />
          </IconButton>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mb-2 rounded-lg bg-surface px-3 py-1 text-sm font-medium text-danger"
        >
          {error}
        </p>
      )}
      <div className="relative flex items-end gap-2">
        {emojiOpen && <EmojiPanel onPick={insertEmoji} onClose={closeEmoji} />}
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
        <div className="pd-floating flex min-h-13 flex-1 items-end gap-1 rounded-2xl p-1.5 transition-shadow focus-within:shadow-[0_0_0_2px_rgb(var(--pd-accent))]">
          <IconButton
            tone="soft"
            aria-label="Send a photo, video or file"
            disabled={!client || editing !== undefined}
            onClick={() => filePicker.current?.click()}
          >
            <Paperclip size={20} />
          </IconButton>
          <textarea
            ref={input}
            aria-label={editing ? 'Edited message' : 'Message'}
            placeholder="Message"
            rows={1}
            maxLength={MAX_TEXT}
            value={text}
            onChange={(event) => changeText(event.target.value)}
            onSelect={(event) => {
              const { selectionStart, selectionEnd } = event.currentTarget;
              selection.current = { start: selectionStart, end: selectionEnd };
            }}
            onBlur={() => void client?.setTyping(conversationId, false).catch(() => undefined)}
            onKeyDown={keyDown}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base text-foreground field-sizing-content placeholder:text-muted focus:outline-none"
          />
          <IconButton
            data-emoji-toggle
            aria-label="Emoji"
            aria-expanded={emojiOpen}
            title="Emoji"
            onClick={() => (emojiOpen ? closeEmoji() : setEmojiOpen(true))}
            className={cn(emojiOpen && 'text-accent')}
          >
            <Smile size={20} />
          </IconButton>
        </div>
        <IconButton
          tone="brand"
          aria-label={editing ? 'Save' : 'Send'}
          title={editing ? 'Save (Enter)' : 'Send (Enter)'}
          onClick={send}
          disabled={!client || trimmed === ''}
          className="size-13"
        >
          {editing ? (
            <Check aria-hidden size={24} />
          ) : (
            <SendHorizontal
              aria-hidden
              size={24}
              className={cn(
                'transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
                trimmed === '' ? '-rotate-30 scale-75' : 'scale-100',
              )}
            />
          )}
        </IconButton>
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
  // One to one only within the circle (Phase 37); unknown until the lists load.
  const circleState = useCircleState(peerUserId);
  const outside = !isGroup && circleState !== undefined && circleState !== 'member';
  const [replyTo, setReplyTo] = useState<MessageRecord>();
  const [editing, setEditing] = useState<MessageRecord>();
  const [deleting, setDeleting] = useState<MessageRecord[]>();
  // Selected messages (Phase 39), and the ones being forwarded.
  const [selection, setSelection] = useState<string[]>([]);
  const [forwarding, setForwarding] = useState<MessageRecord[]>([]);
  const [done, setDone] = useState<string>();
  const [highlight, setHighlight] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<VirtuosoHandle>(null);
  // A chat opens on its newest message. The list places itself before its rows exist (the
  // leader tab may still be starting) and before they are measured, which left it at the top
  // or short of the end in Chrome. So for a moment after the first rows render, it is moved
  // to the end again, unless the reader has started scrolling.
  const settleFrom = useRef<number | undefined>(undefined);
  const touched = useRef(false);
  const scroller = useRef<HTMLElement | null>(null);
  useEffect(() => {
    settleFrom.current = undefined;
    touched.current = false;
  }, [conversationId]);
  /**
   * To the real end of the content. The list's own `scrollToIndex('LAST')` stopped 58 px
   * short in Chrome (its idea of the end, not the rendered one), so the DOM decides.
   */
  const toEnd = useCallback(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);
  const settle = useCallback(
    (rendered: number) => {
      if (rendered === 0 || touched.current) return;
      const now = Date.now();
      settleFrom.current ??= now;
      if (now - settleFrom.current > 1_500) return;
      requestAnimationFrame(toEnd);
    },
    [toEnd],
  );
  // A new message at the end: followed when the reader was at the end, and always when it was
  // just sent from this browser. Again once its row is measured.
  const lastKey = items.at(-1)?.key;
  const previousLastKey = useRef(lastKey);
  // Whether the reader is at the end, from scroll events only: a new row makes the content
  // taller without a scroll event, so it does not count as having scrolled away (the list's
  // own "at bottom" flipped before the new row could be followed).
  const atEnd = useRef(true);
  // Reading older messages, and what was newest when the reader left the end (Phase 36).
  const [reading, setReading] = useState(false);
  const [seen, setSeen] = useState<SeenMark>();
  useEffect(() => {
    atEnd.current = true;
    setReading(false);
  }, [conversationId]);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    atEnd.current = isAtEnd(element.scrollTop, element.clientHeight, element.scrollHeight, 40);
    setReading(!atEnd.current);
  }, []);
  const watchScroller = useCallback(
    (element: HTMLElement | Window | null) => {
      scroller.current?.removeEventListener('scroll', onScroll);
      scroller.current = element instanceof HTMLElement ? element : null;
      scroller.current?.addEventListener('scroll', onScroll, { passive: true });
    },
    [onScroll],
  );
  useEffect(() => {
    if (lastKey === previousLastKey.current) return;
    previousLastKey.current = lastKey;
    const last = items.at(-1);
    const ownNew =
      last?.type === 'message' &&
      last.message.senderDeviceId === deviceId &&
      Date.now() - last.message.sortAt < 10_000;
    if (!atEnd.current && !ownNew) return;
    requestAnimationFrame(toEnd);
    const again = setTimeout(toEnd, 200);
    return () => clearTimeout(again);
  }, [lastKey, items, deviceId, toEnd]);

  useEffect(() => {
    if (!client) return;
    void client.getConversation(conversationId).then(setConversation, () => undefined);
    setReplyTo(undefined);
    setEditing(undefined);
    setSelection([]);
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
  useEffect(() => {
    if (!reading) setSeen(undefined);
    else setSeen((current) => current ?? newestMark(itemsRef.current));
  }, [reading]);
  const unseen = reading ? unseenCount(items, seen) : 0;
  // Sending, or the pill: to the newest message, even from older ones.
  const jumpToEnd = useCallback(() => {
    atEnd.current = true;
    setSeen(newestMark(itemsRef.current));
    toEnd();
    requestAnimationFrame(toEnd);
  }, [toEnd]);
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

  // Selecting several messages (Phase 39): the toolbar's Select starts, clicks add or remove,
  // and Esc, ✕ or unselecting the last one stops. A message deleted meanwhile drops out.
  const picked = useMemo(() => selectedMessages(selection, loaded), [selection, loaded]);
  const selecting = picked.length > 0;
  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setSelection([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(undefined), 4_000);
    return () => clearTimeout(timer);
  }, [done]);

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
    remove: (message) => setDeleting([message]),
    retry: (message) => void client?.retry(message.messageId).catch(() => undefined),
    jumpTo: (messageId) => void jumpTo(messageId),
    canEdit: (message) => canEdit(message, names.selfUserId, RULES, now),
    select: (message) => setSelection((current) => toggleSelected(current, message.messageId)),
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
      <div className="pd-skeleton flex h-full items-center justify-center font-semibold text-muted">
        Opening the chat…
      </div>
    );
  }
  const oldestMessage = items.find(
    (item): item is Extract<TimelineItem, { type: 'message' }> => item.type === 'message',
  )?.message;
  // Messages scroll under the floating header, so the list starts below it. The "older from
  // phone" area always takes the same height: when it grew or shrank after the list had
  // placed itself, the list's idea of its bottom went wrong and a chat opened short of the
  // newest message (measured in Chrome).
  const listHeader = () => (
    <div className="pt-20">
      <div className="h-20 overflow-hidden">
        {complete && <OlderFromPhone conversationId={conversationId} oldest={oldestMessage} />}
      </div>
    </div>
  );
  const name = isGroup ? groupName(group) : contactName(peer);
  const readReceipts = privacy?.readReceipts ?? false;

  const copyCount = picked.filter(copyable).length;
  const canForward = selecting && picked.every(forwardable) && !blocked;
  const one = picked.length === 1 ? picked[0] : undefined;
  const deleteCheck = deleting
    ? deleteForEveryoneCheck(deleting, names.selfUserId, RULES, now)
    : undefined;

  return (
    <div className="relative flex h-full flex-col">
      {selecting ? (
        <header
          aria-label="Selected messages"
          className="pd-floating absolute inset-x-3 top-3 z-10 flex min-h-[60px] items-center gap-1 rounded-2xl p-1.5"
        >
          <IconButton aria-label="Stop selecting (Esc)" onClick={() => setSelection([])}>
            <X size={20} />
          </IconButton>
          <span aria-live="polite" className="min-w-0 flex-1 truncate pl-1 text-lg font-bold">
            {picked.length} selected
          </span>
          {one && !(blocked || left || outside) && one.kind !== 'deleted' && (
            <IconButton
              aria-label="Reply"
              onClick={() => {
                setSelection([]);
                actions.reply(one);
              }}
            >
              <Reply size={20} />
            </IconButton>
          )}
          {copyCount > 0 && (
            <IconButton
              aria-label="Copy"
              onClick={() => {
                void navigator.clipboard.writeText(copyText(picked, names)).then(
                  () => {
                    setDone(copyCount === 1 ? 'Copied' : `${copyCount} messages copied`);
                    setSelection([]);
                  },
                  () => setNotice('Copying did not work. Try again.'),
                );
              }}
            >
              <Copy size={20} />
            </IconButton>
          )}
          {canForward && (
            <IconButton
              aria-label="Forward"
              onClick={() => {
                setForwarding(picked);
                setSelection([]);
              }}
            >
              <Forward size={20} />
            </IconButton>
          )}
          <IconButton aria-label="Delete" onClick={() => setDeleting(picked)}>
            <Trash2 size={20} />
          </IconButton>
        </header>
      ) : (
        <Header conversation={conversation} />
      )}
      {status !== 'online' && (
        <p
          className="pd-rise absolute inset-x-6 top-22 z-10 rounded-lg bg-warning/20 px-4 py-1 text-center text-sm font-semibold backdrop-blur"
          role="status"
        >
          {status === 'connecting'
            ? 'Connecting…'
            : 'Offline. Messages you write wait here and go out when you are back.'}
        </p>
      )}
      <div
        className="relative min-h-0 flex-1"
        onWheel={() => (touched.current = true)}
        onTouchStart={() => (touched.current = true)}
        onKeyDown={() => (touched.current = true)}
      >
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center pt-16">
            <EmptyState icon={Lock} title="Just you two">
              {isGroup
                ? `Messages in ${name} are end-to-end encrypted for its members. No one else, not even PingDost, can read them.`
                : `Messages with ${name} are end-to-end encrypted. No one else, not even PingDost, can read them.`}
            </EmptyState>
            {complete && <OlderFromPhone conversationId={conversationId} oldest={undefined} />}
          </div>
        ) : (
          <Virtuoso
            ref={list}
            scrollerRef={watchScroller}
            data={items}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={items.length - 1}
            itemsRendered={(rendered) => settle(rendered.length)}
            totalListHeightChanged={() => {
              settle(1);
              // Rows that change height at the end (a time line moving to the newest bubble).
              if (atEnd.current) requestAnimationFrame(toEnd);
            }}
            // Following new messages is done below (`toEnd`): the list's own follow stopped
            // short of the end like `scrollToIndex`.
            followOutput={false}
            startReached={() => void loadOlder()}
            atBottomStateChange={setAtBottom}
            computeItemKey={(_, item) => item.key}
            components={{ Header: listHeader }}
            itemContent={(index, item) =>
              item.type === 'day' ? (
                <div className="my-3 flex justify-center">
                  <span className="rounded-full bg-surface/90 px-3 py-1 text-xs font-bold text-muted">
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
                  first={!continuesRun(item.message, items[index - firstItemIndex - 1])}
                  last={!continuesRun(item.message, items[index - firstItemIndex + 1])}
                  // Scrolling back to it later must not replay the entrance.
                  fresh={Date.now() - item.message.sortAt < 1_200}
                  readOnly={blocked || left || outside}
                  selecting={selecting}
                  checked={selecting && selection.includes(item.message.messageId)}
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
        <div aria-live="polite" className="absolute inset-x-0 bottom-3 z-10 flex justify-center">
          {unseen > 0 && (
            <button
              type="button"
              onClick={jumpToEnd}
              className="pd-pop pd-floating bg-brand flex h-10 items-center gap-2 rounded-full px-4 font-bold text-on-primary focus-visible:outline-2 focus-visible:outline-accent"
            >
              <ArrowDown aria-hidden size={18} strokeWidth={2.6} />
              {unseenLabel(unseen)}
            </button>
          )}
        </div>
        {!atBottom && unseen === 0 && items.length > 0 && (
          <IconButton
            aria-label="Jump to the latest message"
            onClick={jumpToEnd}
            className="pd-pop pd-floating absolute right-4 bottom-3 z-10"
          >
            <ArrowDown size={20} />
          </IconButton>
        )}
      </div>
      {typing && !blocked && (
        <div
          aria-live="polite"
          aria-label={`${name} is typing`}
          className="pd-rise ml-4 flex h-9 w-fit items-center gap-1 rounded-xl bg-bubble-in px-4"
        >
          <span className="pd-dot size-2 rounded-full bg-muted" />
          <span className="pd-dot size-2 rounded-full bg-muted" />
          <span className="pd-dot size-2 rounded-full bg-muted" />
        </div>
      )}
      {notice && (
        <p
          role="alert"
          className="mx-4 mt-1 rounded-lg bg-surface px-3 py-1 text-sm font-medium text-danger"
        >
          {notice}
        </p>
      )}
      {done && (
        <p
          role="status"
          className="pd-rise mx-4 mt-1 rounded-lg bg-surface px-3 py-1 text-sm font-medium text-success"
        >
          {done}
        </p>
      )}
      {left ? (
        <p className="m-3 rounded-xl bg-surface p-4 text-center text-muted">
          You&apos;re no longer a member of this group. You can read what is here, but not send.
        </p>
      ) : blocked && peerUserId ? (
        <div className="m-3 flex items-center justify-center gap-3 rounded-xl bg-surface p-4">
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
      ) : outside && peerUserId ? (
        <div className="m-3 flex flex-col gap-3 rounded-xl bg-surface p-4">
          {circleState === 'none' && (
            <p className="text-center text-muted">Add {name} to your circle to message them.</p>
          )}
          <CircleAction userId={peerUserId} name={name} />
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
          onSent={jumpToEnd}
        />
      )}
      <ForwardDialog
        messages={forwarding}
        selfUserId={names.selfUserId}
        onClose={(result) => {
          setForwarding([]);
          if (result) setDone(result);
        }}
      />
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={
          deleting && deleting.length > 1
            ? `Delete ${deleting.length} messages?`
            : 'Delete this message?'
        }
      >
        <div className="flex flex-col gap-2">
          <Button
            variant="danger"
            onClick={() => {
              if (deleting) void client?.deleteForMe(deleting.map((m) => m.messageId));
              setDeleting(undefined);
              setSelection([]);
            }}
          >
            Delete for me
          </Button>
          <p className="text-sm text-muted">
            Removes {deleting && deleting.length > 1 ? 'them' : 'it'} from this browser only.
          </p>
          {deleting &&
            !left &&
            !outside &&
            (deleteCheck?.allowed &&
            deleting.every((m) => canDeleteForEveryone(m, names.selfUserId, RULES, now)) ? (
              <>
                <Button
                  variant="danger"
                  onClick={() => {
                    const ids = deleting.map((m) => m.messageId);
                    const sent =
                      ids.length > 1
                        ? client?.deleteManyForEveryone(ids)
                        : client?.deleteForEveryone(ids[0] ?? '');
                    sent?.catch((e: unknown) => setNotice(failure(e)));
                    setDeleting(undefined);
                    setSelection([]);
                  }}
                >
                  Delete for everyone
                </Button>
                <p className="text-sm text-muted">
                  Asks every copy to be removed. It can&apos;t erase screenshots, exports or copies
                  already saved elsewhere.
                </p>
              </>
            ) : (
              deleteCheck &&
              !deleteCheck.allowed && <p className="text-sm text-muted">{deleteCheck.reason}</p>
            ))}
          <Button variant="secondary" onClick={() => setDeleting(undefined)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
