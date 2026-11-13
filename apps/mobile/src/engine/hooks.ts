// React bindings for the chat engine: the chat list, a conversation's timeline, typing and
// contacts. Everything reads from the local store; the engine's events keep it current.
//
// Recent chats' newest pages are also kept in memory (`pages`), filled in the background from
// the chat list and kept current by the engine's events, so a chat opens with its messages
// (new ones included) on the first frame; the store is read again right after.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAccount } from '@/settings/account';
import type { ConversationRecord, MessageRecord } from '@pingdost/message-engine';

import { loadContact, useContacts, type Contact } from './contacts';
import { useChatStore, type ChatRuntime } from './runtime';
import { buildTimeline, type TimelineItem } from './timeline';

const PAGE = 50;
/** Chats whose newest page stays in memory (most recently listed or opened). */
const CACHED_CHATS = 24;

interface CachedPage {
  messages: Map<string, MessageRecord>;
  /** The store has nothing older. */
  exhausted: boolean;
  /** Filled from the store (not only from events while it loaded). */
  complete: boolean;
}

const pages = new Map<string, CachedPage>();
let pagesRuntime: ChatRuntime | undefined;
let stopPages: (() => void) | undefined;

const newerFirst = (a: MessageRecord, b: MessageRecord) =>
  b.sortAt - a.sortAt || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0);

/** The cache belongs to one runtime; a new one (sign-in, restart) starts it over. */
function pagesFor(runtime: ChatRuntime): Map<string, CachedPage> {
  if (pagesRuntime === runtime) return pages;
  stopPages?.();
  pages.clear();
  pagesRuntime = runtime;
  const stops = [
    runtime.engine.subscribeAll((conversationId, event) => {
      const page = pages.get(conversationId);
      if (!page) return;
      if (event.type === 'message') {
        page.messages.set(event.message.messageId, event.message);
        trim(page);
      } else if (event.type === 'removed') {
        for (const id of event.messageIds) page.messages.delete(id);
      }
    }),
    // A chat deleted from this phone (its ID comes back if it is started again).
    runtime.engine.onEvent((event) => {
      if (event.type === 'content_removed') pages.clear();
    }),
  ];
  stopPages = () => {
    for (const stop of stops) stop();
  };
  return pages;
}

/** Keeps only the newest page (events keep adding to it). */
function trim(page: CachedPage): void {
  if (page.messages.size <= PAGE * 2) return;
  const newest = [...page.messages.values()].sort(newerFirst).slice(0, PAGE);
  page.messages = new Map(newest.map((m) => [m.messageId, m]));
  page.exhausted = false;
}

function touch(cache: Map<string, CachedPage>, conversationId: string, page: CachedPage): void {
  cache.delete(conversationId);
  cache.set(conversationId, page);
  while (cache.size > CACHED_CHATS) cache.delete(cache.keys().next().value!);
}

function remember(
  runtime: ChatRuntime,
  conversationId: string,
  messages: Iterable<MessageRecord>,
  exhausted: boolean,
): void {
  // A chat closing as its runtime stops must not start the cache over for it.
  if (useChatStore.getState().runtime !== runtime) return;
  const page: CachedPage = {
    messages: new Map([...messages].map((m) => [m.messageId, m])),
    exhausted,
    complete: true,
  };
  trim(page);
  touch(pagesFor(runtime), conversationId, page);
}

/** A copy of the cached newest page, if this chat has one. */
function cachedPage(runtime: ChatRuntime | null, conversationId: string): CachedPage | undefined {
  if (!runtime) return undefined;
  const page = pagesFor(runtime).get(conversationId);
  return page && { ...page, messages: new Map(page.messages) };
}

/** Reads one chat's newest page into memory, unless it is there already. */
export async function prefetchConversation(
  runtime: ChatRuntime,
  conversationId: string,
): Promise<void> {
  const cache = pagesFor(runtime);
  if (cache.has(conversationId)) return;
  // Listed before the read, so events arriving meanwhile land in it (and win: they are newer).
  const page: CachedPage = { messages: new Map(), exhausted: false, complete: false };
  touch(cache, conversationId, page);
  try {
    const stored = await runtime.engine.listMessages(conversationId, { limit: PAGE });
    for (const m of stored) if (!page.messages.has(m.messageId)) page.messages.set(m.messageId, m);
    page.exhausted = stored.length < PAGE;
    page.complete = true;
  } catch {
    if (cache.get(conversationId) === page) cache.delete(conversationId);
  }
}

let wanted: { runtime: ChatRuntime; conversationIds: readonly string[] } | undefined;
let prefetching = false;

/**
 * Loads the chat list's top chats into memory in the background, one at a time with frames
 * and taps in between (the reads are synchronous). A newer list replaces the one in progress.
 */
export function prefetchConversations(
  runtime: ChatRuntime,
  conversationIds: readonly string[],
): void {
  wanted = { runtime, conversationIds };
  if (prefetching) return;
  prefetching = true;
  void (async () => {
    try {
      while (wanted) {
        const next = wanted;
        wanted = undefined;
        for (const conversationId of next.conversationIds.slice(0, CACHED_CHATS)) {
          if (pagesRuntime !== undefined && pagesRuntime !== next.runtime) break;
          if (pagesFor(next.runtime).has(conversationId)) continue;
          await prefetchConversation(next.runtime, conversationId);
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (wanted) break;
        }
      }
    } catch {
      // Signed out meanwhile; the next list starts again.
    } finally {
      prefetching = false;
    }
  })();
}

export function useChatRuntime(): ChatRuntime | null {
  return useChatStore((state) => state.runtime);
}

export function useConnectionStatus() {
  return useChatStore((state) => state.status);
}

export interface ChatListEntry {
  conversation: ConversationRecord;
  last: MessageRecord | undefined;
}

/** All conversations, most recent first, with their last message (decrypted locally). */
export function useConversations(): { entries: ChatListEntry[]; loading: boolean } {
  const runtime = useChatRuntime();
  const [entries, setEntries] = useState<ChatListEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    const load = async () => {
      const conversations = await runtime.engine.listConversations();
      const next = await Promise.all(
        conversations.map(async (conversation) => ({
          conversation,
          last: conversation.lastMessageId
            ? await runtime.engine.getMessage(conversation.lastMessageId)
            : undefined,
        })),
      );
      if (!live) return;
      setEntries(next);
      setLoading(false);
      // The chats most likely to be opened next, ready in memory (unread ones first).
      const likely = [...conversations].sort(
        (a, b) => Number(b.unreadCount > 0) - Number(a.unreadCount > 0),
      );
      prefetchConversations(
        runtime,
        likely.filter((c) => !c.archived).map((c) => c.conversationId),
      );
    };
    void load();
    const unsubscribe = runtime.engine.onConversationListChanged(() => void load());
    return () => {
      live = false;
      unsubscribe();
    };
  }, [runtime]);

  return { entries, loading: loading || !runtime };
}

export interface ConversationView {
  items: TimelineItem[];
  /** The loaded messages by ID (quotes resolve here first). */
  loaded: ReadonlyMap<string, MessageRecord>;
  /** Loads the next older page; false when there is none. */
  loadOlder: () => Promise<boolean>;
  /** Loads older pages until `messageId` is loaded (e.g. a search result); false if never. */
  loadUntil: (messageId: string) => Promise<boolean>;
  /** The peer is typing (only when typing indicators are on). */
  typing: boolean;
  /** The store was read: an empty timeline really is empty. */
  ready: boolean;
}

/**
 * One conversation's timeline, newest page first, kept live by the engine's events. It starts
 * from the in-memory page when there is one, so the first frame already shows the messages.
 */
export function useConversation(conversationId: string): ConversationView {
  const runtime = useChatRuntime();
  const [initial] = useState(() => cachedPage(runtime, conversationId));
  const [messages, setMessages] = useState<Map<string, MessageRecord>>(
    () => initial?.messages ?? new Map(),
  );
  const [ready, setReady] = useState(initial?.complete ?? false);
  const [typing, setTyping] = useState(false);
  const exhausted = useRef(initial?.exhausted ?? false);
  const loadingOlder = useRef(false);
  // The newest map, for callbacks that run across renders (paging, jump to a message).
  const latest = useRef(messages);
  latest.current = messages;

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    const cached = cachedPage(runtime, conversationId);
    if (latest.current.size === 0 && cached) {
      // Another chat in this screen, or the runtime arrived after the first render.
      latest.current = cached.messages;
      setMessages(cached.messages);
      setReady(cached.complete);
    }
    exhausted.current = cached?.exhausted ?? false;
    // What events said while the store was read: newer than the read, so they win.
    const changed = new Map<string, MessageRecord>();
    const removed = new Set<string>();
    const unsubscribe = runtime.engine.subscribe(conversationId, (event) => {
      if (!live) return;
      if (event.type === 'message') {
        changed.set(event.message.messageId, event.message);
        removed.delete(event.message.messageId);
        setMessages((current) => new Map(current).set(event.message.messageId, event.message));
      } else if (event.type === 'removed') {
        for (const id of event.messageIds) {
          changed.delete(id);
          removed.add(id);
        }
        setMessages((current) => {
          const next = new Map(current);
          for (const id of event.messageIds) next.delete(id);
          return next;
        });
      } else setTyping(event.active);
    });
    void runtime.engine.listMessages(conversationId, { limit: PAGE }).then((page) => {
      if (!live) return;
      exhausted.current = page.length < PAGE;
      const oldest = page.at(-1);
      setMessages((current) => {
        // The store's newest page replaces what the memory had; older pages loaded meanwhile
        // stay.
        const next = new Map<string, MessageRecord>();
        if (oldest && !exhausted.current) {
          for (const m of current.values()) if (newerFirst(m, oldest) > 0) next.set(m.messageId, m);
        }
        for (const m of page) if (!removed.has(m.messageId)) next.set(m.messageId, m);
        for (const m of changed.values()) next.set(m.messageId, m);
        return next;
      });
      setReady(true);
    });
    return () => {
      live = false;
      unsubscribe();
      // Leaving the chat: its newest page stays in memory for the next visit.
      if (latest.current.size > 0) {
        remember(runtime, conversationId, latest.current.values(), exhausted.current);
      }
      latest.current = new Map();
      setMessages(new Map());
      setReady(false);
      setTyping(false);
    };
  }, [runtime, conversationId]);

  const loadOlder = useCallback(async () => {
    if (!runtime || exhausted.current || loadingOlder.current) return false;
    const oldest = [...latest.current.values()].reduce<MessageRecord | undefined>(
      (min, m) =>
        !min || m.sortAt < min.sortAt || (m.sortAt === min.sortAt && m.messageId < min.messageId)
          ? m
          : min,
      undefined,
    );
    if (!oldest) return false;
    loadingOlder.current = true;
    try {
      const page = await runtime.engine.listMessages(conversationId, {
        limit: PAGE,
        before: { sortAt: oldest.sortAt, messageId: oldest.messageId },
      });
      if (page.length < PAGE) exhausted.current = true;
      setMessages((current) => {
        const next = new Map(current);
        for (const record of page) next.set(record.messageId, record);
        latest.current = next;
        return next;
      });
      return page.length > 0;
    } finally {
      loadingOlder.current = false;
    }
  }, [runtime, conversationId]);
  const loadUntil = useCallback(
    async (messageId: string) => {
      for (let page = 0; page < 40; page++) {
        if (latest.current.has(messageId)) return true;
        if (!(await loadOlder())) break;
        // Let the merged page render before looking again.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return latest.current.has(messageId);
    },
    [loadOlder],
  );

  const items = useMemo(() => buildTimeline([...messages.values()]), [messages]);
  return { items, loaded: messages, loadOlder, loadUntil, typing, ready };
}

/**
 * The message a reply quotes, if this device has it in the same conversation: from the loaded
 * page, else from the store. Undefined means "Original message not available".
 */
export function useQuoted(
  replyTo: string | null,
  conversationId: string,
  loaded: ReadonlyMap<string, MessageRecord>,
): MessageRecord | undefined {
  const runtime = useChatRuntime();
  const [fetched, setFetched] = useState<MessageRecord>();
  const local = replyTo ? loaded.get(replyTo) : undefined;
  useEffect(() => {
    if (!replyTo || local || !runtime) return;
    let live = true;
    void runtime.engine.getMessage(replyTo).then((message) => {
      if (live) setFetched(message);
    });
    return () => {
      live = false;
    };
  }, [replyTo, local, runtime]);
  const quoted = local ?? fetched;
  return quoted?.conversationId === conversationId ? quoted : undefined;
}

const jumps = new Map<string, string>();

/** Asks the conversation's (already open) chat screen to scroll to a message when focused. */
export function requestJump(conversationId: string, messageId: string): void {
  jumps.set(conversationId, messageId);
}

/** The message to scroll to, once. */
export function takeJump(conversationId: string): string | undefined {
  const messageId = jumps.get(conversationId);
  jumps.delete(conversationId);
  return messageId;
}

/** Whether this user shares read receipts; when off, others' are not shown either. */
export function useReadReceipts(): boolean {
  return useAccount((state) => state.privacy?.readReceipts ?? false);
}

/** A contact's cached profile, refreshed in the background. */
export function useContact(userId: string | undefined): Contact | undefined {
  const contact = useContacts((state) => (userId ? state.byId[userId] : undefined));
  useEffect(() => {
    if (userId) void loadContact(userId);
  }, [userId]);
  return contact;
}

/** Whether a watched user is online (only while their chat is open and both share it). */
export function usePresence(userId: string | undefined): boolean {
  return useChatStore((state) => (userId ? (state.presence[userId] ?? false) : false));
}
