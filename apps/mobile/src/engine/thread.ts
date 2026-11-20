// One chat's messages as the in-memory chat store keeps them (engine/chat-store.ts): newest
// first, the order the chat's inverted list draws them in. Every change returns a new thread
// and keeps unchanged records as the same objects, so memoized bubbles do not redraw. Pure, so
// it is unit-tested without React Native.
import type { MessageRecord } from '@pingdost/message-engine';

export interface Thread {
  /** Newest first. */
  readonly messages: readonly MessageRecord[];
  readonly byId: ReadonlyMap<string, MessageRecord>;
  /** The store has nothing older than the oldest one here. */
  readonly exhausted: boolean;
  /** Read from the store (not only messages that arrived as events). */
  readonly complete: boolean;
}

export const EMPTY_THREAD: Thread = {
  messages: [],
  byId: new Map(),
  exhausted: false,
  complete: false,
};

/** Newest first, as the store pages them. */
export const newerFirst = (a: MessageRecord, b: MessageRecord) =>
  b.sortAt - a.sortAt || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0);

/** Same content (the store returns new objects on every read). */
export function sameRecord<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof T>;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (x === y) continue;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

function build(
  byId: Map<string, MessageRecord>,
  exhausted: boolean,
  complete: boolean,
  previous: Thread,
): Thread {
  const messages = [...byId.values()].sort(newerFirst);
  const same =
    messages.length === previous.messages.length &&
    messages.every((m, index) => previous.messages[index] === m);
  if (same && exhausted === previous.exhausted && complete === previous.complete) return previous;
  return { messages: same ? previous.messages : messages, byId, exhausted, complete };
}

/** Older than everything loaded, while the store has more: it belongs to a page not read yet. */
function beyondLoaded(thread: Thread, message: MessageRecord): boolean {
  const oldest = thread.messages.at(-1);
  return thread.complete && !thread.exhausted && !!oldest && newerFirst(message, oldest) > 0;
}

/** A message was added or changed (an engine event). */
export function upsertMessage(thread: Thread, message: MessageRecord): Thread {
  const old = thread.byId.get(message.messageId);
  // That page reads it from the store when it is loaded.
  if (!old && beyondLoaded(thread, message)) return thread;
  const byId = new Map(thread.byId).set(message.messageId, message);
  // Usually the newest, or a change in place: no sort needed.
  if (old && old.sortAt === message.sortAt) {
    const messages = thread.messages.map((m) => (m.messageId === message.messageId ? message : m));
    return { ...thread, messages, byId };
  }
  const newest = thread.messages[0];
  if (!old && (!newest || newerFirst(message, newest) < 0)) {
    return { ...thread, messages: [message, ...thread.messages], byId };
  }
  return build(byId, thread.exhausted, thread.complete, thread);
}

/** Messages deleted from this device. */
export function removeMessages(thread: Thread, messageIds: readonly string[]): Thread {
  if (!messageIds.some((id) => thread.byId.has(id))) return thread;
  const byId = new Map(thread.byId);
  for (const id of messageIds) byId.delete(id);
  return build(byId, thread.exhausted, thread.complete, thread);
}

/**
 * The store's newest page, read into a thread that so far held only events. Those events are
 * newer than the read and win. Events older than the page belong to pages not loaded yet (which
 * will read them from the store), so they go: the thread has no gaps.
 */
export function withNewestPage(
  thread: Thread,
  page: readonly MessageRecord[],
  exhausted: boolean,
): Thread {
  const oldest = page.at(-1);
  const byId = new Map<string, MessageRecord>();
  for (const m of page) byId.set(m.messageId, thread.byId.get(m.messageId) ?? m);
  for (const m of thread.messages) {
    if (byId.has(m.messageId)) continue;
    if (exhausted || !oldest || newerFirst(m, oldest) < 0) byId.set(m.messageId, m);
  }
  return build(byId, exhausted, true, thread);
}

/** The next older page, read when scrolling up. */
export function withOlderPage(
  thread: Thread,
  page: readonly MessageRecord[],
  exhausted: boolean,
): Thread {
  const byId = new Map(thread.byId);
  for (const m of page) if (!byId.has(m.messageId)) byId.set(m.messageId, m);
  return build(byId, exhausted, thread.complete, thread);
}

/** Back to the newest `size` messages (a chat that was scrolled far up, once it is left). */
export function trimThread(thread: Thread, size: number): Thread {
  if (thread.messages.length <= size) return thread;
  const messages = thread.messages.slice(0, size);
  return {
    messages,
    byId: new Map(messages.map((m) => [m.messageId, m])),
    exhausted: false,
    complete: thread.complete,
  };
}
