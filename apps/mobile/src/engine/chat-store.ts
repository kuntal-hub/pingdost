// Every chat in memory: the chat list, and each chat's newest messages, read from the local
// database once when the app opens and then kept current by the engine's events (ADR 0047).
// Screens render from here and never wait for the database: a chat opens with its messages on
// its first frame.
//
// Records that did not change keep their objects, so a change redraws only what it touches
// (one bubble, one chat row).
import { create } from 'zustand';

import type {
  ConversationEvent,
  ConversationRecord,
  MessageRecord,
} from '@pingdost/message-engine';

import { useChatStore, type ChatRuntime } from './runtime';
import {
  EMPTY_THREAD,
  removeMessages,
  sameRecord,
  trimThread,
  upsertMessage,
  withNewestPage,
  withOlderPage,
  type Thread,
} from './thread';

export type { Thread } from './thread';

/** Messages per page: each chat's newest page is in memory, older ones load on scrolling up. */
export const PAGE = 50;
/** Chats read per step while the app opens, with frames and taps in between. */
const CHATS_PER_STEP = 6;

export interface ChatListEntry {
  conversation: ConversationRecord;
  last: MessageRecord | undefined;
}

interface ChatData {
  /** Every conversation, most recent first, with its last message. */
  entries: readonly ChatListEntry[];
  conversations: Readonly<Record<string, ConversationRecord>>;
  /** Each chat's newest messages (more once scrolled up). */
  threads: Readonly<Record<string, Thread>>;
  /** Who is typing, by conversation (only while typing indicators are on). */
  typing: Readonly<Record<string, boolean>>;
  /** The chat list was read from the database. */
  listed: boolean;
}

const EMPTY: ChatData = { entries: [], conversations: {}, threads: {}, typing: {}, listed: false };

export const useChatData = create<ChatData>(() => EMPTY);

let owner: ChatRuntime | undefined;
let stopOwner: (() => void) | undefined;

const current = (runtime: ChatRuntime) =>
  owner === runtime && useChatStore.getState().runtime === runtime;

function setThread(conversationId: string, update: (thread: Thread) => Thread): void {
  const { threads } = useChatData.getState();
  const before = threads[conversationId] ?? EMPTY_THREAD;
  const after = update(before);
  if (after !== before) useChatData.setState({ threads: { ...threads, [conversationId]: after } });
}

function onConversationEvent(conversationId: string, event: ConversationEvent): void {
  if (event.type === 'message') {
    setThread(conversationId, (thread) => upsertMessage(thread, event.message));
  } else if (event.type === 'removed') {
    setThread(conversationId, (thread) => removeMessages(thread, event.messageIds));
  } else {
    const { typing } = useChatData.getState();
    if ((typing[conversationId] ?? false) !== event.active) {
      useChatData.setState({ typing: { ...typing, [conversationId]: event.active } });
    }
  }
}

/** Re-reads the chat list. Unchanged rows keep their objects (the list does not redraw them). */
async function readList(runtime: ChatRuntime): Promise<void> {
  const list = await runtime.engine.listConversations();
  const before = useChatData.getState();
  const previous = new Map(before.entries.map((e) => [e.conversation.conversationId, e]));
  const entries = await Promise.all(
    list.map(async (record): Promise<ChatListEntry> => {
      const old = previous.get(record.conversationId);
      const conversation = old && sameRecord(old.conversation, record) ? old.conversation : record;
      const lastId = record.lastMessageId;
      const last = lastId
        ? (useChatData.getState().threads[record.conversationId]?.byId.get(lastId) ??
          (old?.last?.messageId === lastId ? old.last : await runtime.engine.getMessage(lastId)))
        : undefined;
      return old && old.conversation === conversation && old.last === last
        ? old
        : { conversation, last };
    }),
  );
  if (!current(runtime)) return;
  const state = useChatData.getState();
  const same =
    entries.length === state.entries.length && entries.every((e, i) => state.entries[i] === e);
  if (same && state.listed) return;
  const conversations: Record<string, ConversationRecord> = {};
  for (const { conversation } of entries) {
    conversations[conversation.conversationId] = conversation;
  }
  // A chat deleted from this phone: its messages go too (its ID comes back if it starts again).
  let threads = state.threads;
  for (const id of Object.keys(state.conversations)) {
    if (!conversations[id] && threads[id]) {
      threads = Object.fromEntries(Object.entries(threads).filter(([key]) => key !== id));
    }
  }
  useChatData.setState({
    entries: same ? state.entries : entries,
    conversations,
    threads,
    listed: true,
  });
}

/** Reads one chat's newest page into memory, unless it is there already. */
async function readThread(runtime: ChatRuntime, conversationId: string): Promise<void> {
  const page = await runtime.engine.listMessages(conversationId, { limit: PAGE });
  if (!current(runtime)) return;
  setThread(conversationId, (thread) =>
    thread.complete ? thread : withNewestPage(thread, page, page.length < PAGE),
  );
}

/** Chats most likely opened first: unread, then the list's order; archived ones last. */
function likelyFirst(entries: readonly ChatListEntry[]): string[] {
  const rank = ({ conversation: c }: ChatListEntry) =>
    (c.archived ? 2 : 0) + (c.unreadCount > 0 ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b)).map((e) => e.conversation.conversationId);
}

/** Reads every chat's newest page, a few chats at a time with frames in between. */
async function readAllThreads(runtime: ChatRuntime): Promise<void> {
  const ids = likelyFirst(useChatData.getState().entries);
  for (let start = 0; start < ids.length; start += CHATS_PER_STEP) {
    for (const id of ids.slice(start, start + CHATS_PER_STEP)) {
      if (!current(runtime)) return;
      if (useChatData.getState().threads[id]?.complete) continue;
      await readThread(runtime, id);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Loads every chat into memory and keeps it current, for this runtime (the signed-in app; not a
 * headless push wake). A new runtime (sign-in, restart) starts it over.
 */
export function startChatData(runtime: ChatRuntime): void {
  if (owner === runtime) return;
  stopChatData();
  owner = runtime;
  useChatData.setState(EMPTY);

  let reading: Promise<void> | undefined;
  let again = false;
  const relist = () => {
    if (reading) {
      again = true;
      return;
    }
    reading = readList(runtime)
      .catch(() => undefined)
      .finally(() => {
        reading = undefined;
        if (again && current(runtime)) {
          again = false;
          relist();
        }
      });
  };
  const stops = [
    runtime.engine.subscribeAll(onConversationEvent),
    runtime.engine.onConversationListChanged(relist),
  ];
  stopOwner = () => {
    for (const stop of stops) stop();
  };
  relist();
  void (async () => {
    try {
      await reading;
      if (current(runtime)) await readAllThreads(runtime);
    } catch {
      // Signed out meanwhile.
    }
  })();
}

/** Signed out or stopped: nothing stays in memory. */
export function stopChatData(): void {
  stopOwner?.();
  stopOwner = undefined;
  owner = undefined;
  older.clear();
  useChatData.setState(EMPTY);
}

/**
 * Makes sure a chat's newest page is in memory (normally it already is). Called as a chat is
 * tapped, so a chat the background read has not reached yet is read before its screen draws.
 */
export function ensureThread(runtime: ChatRuntime, conversationId: string): Promise<void> {
  if (owner !== runtime) startChatData(runtime);
  if (useChatData.getState().threads[conversationId]?.complete) return Promise.resolve();
  return readThread(runtime, conversationId).catch(() => undefined);
}

/** Older pages being read, by conversation: a second caller waits for the same read. */
const older = new Map<string, Promise<boolean>>();

/** Reads the next older page of a chat into memory; false when there is none. */
export function loadOlderMessages(runtime: ChatRuntime, conversationId: string): Promise<boolean> {
  const reading = older.get(conversationId);
  if (reading) return reading;
  const thread = useChatData.getState().threads[conversationId];
  const oldest = thread?.messages.at(-1);
  if (!thread?.complete || thread.exhausted || !oldest) return Promise.resolve(false);
  const read = (async () => {
    try {
      const page = await runtime.engine.listMessages(conversationId, {
        limit: PAGE,
        before: { sortAt: oldest.sortAt, messageId: oldest.messageId },
      });
      if (!current(runtime)) return false;
      setThread(conversationId, (t) => withOlderPage(t, page, page.length < PAGE));
      return page.length > 0;
    } finally {
      older.delete(conversationId);
    }
  })();
  older.set(conversationId, read);
  return read;
}

/** A chat was left: only its newest page stays in memory, and no one is typing in it. */
export function releaseThread(conversationId: string): void {
  setThread(conversationId, (thread) => trimThread(thread, PAGE));
  const { typing } = useChatData.getState();
  if (typing[conversationId])
    useChatData.setState({ typing: { ...typing, [conversationId]: false } });
}
