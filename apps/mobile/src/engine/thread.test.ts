import { describe, expect, it } from 'vitest';

import type { MessageRecord } from '@pingdost/message-engine';

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

function message(n: number, extra: Partial<MessageRecord> = {}): MessageRecord {
  return {
    messageId: `m${String(n).padStart(3, '0')}`,
    conversationId: 'c1',
    senderUserId: 'u1',
    senderDeviceId: 'd1',
    direction: 'out',
    kind: 'text',
    body: `hello ${n}`,
    attachment: null,
    replyTo: null,
    sentAt: n,
    sortAt: n,
    createdAt: n,
    state: 'delivered_to_recipient_device',
    expiresAt: null,
    editedAt: null,
    editId: null,
    deletedAt: null,
    readAt: null,
    reactions: [],
    ...extra,
  };
}

/** The store's newest-first page: fresh objects, as every read returns. */
const page = (...ns: number[]) => ns.map((n) => message(n)).reverse();
const ids = (thread: Thread) => thread.messages.map((m) => m.messageId);
const read = (ns: number[], exhausted: boolean) =>
  withNewestPage(EMPTY_THREAD, page(...ns), exhausted);

describe('sameRecord', () => {
  it('compares content, including reactions and attachments', () => {
    const a = message(1, { reactions: [{ userId: 'u2', emoji: '👍', at: 5, id: 'r1' }] });
    expect(sameRecord(a, structuredClone(a))).toBe(true);
    expect(sameRecord(a, { ...a, state: 'read' })).toBe(false);
    expect(sameRecord(a, { ...a, reactions: [] })).toBe(false);
    expect(sameRecord(a, { ...a, forwarded: true })).toBe(false);
  });
});

describe('thread', () => {
  it('keeps the newest page newest first, read from the store', () => {
    const thread = read([1, 2, 3], true);
    expect(ids(thread)).toEqual(['m003', 'm002', 'm001']);
    expect(thread.complete).toBe(true);
    expect(thread.exhausted).toBe(true);
    expect(thread.byId.get('m002')?.body).toBe('hello 2');
  });

  it('puts a new message first and changes one in place, keeping the other objects', () => {
    const thread = read([1, 2], false);
    const added = upsertMessage(thread, message(3));
    expect(ids(added)).toEqual(['m003', 'm002', 'm001']);
    expect(added.messages[1]).toBe(thread.messages[0]);

    const tick = message(2, { state: 'read' });
    const changed = upsertMessage(added, tick);
    expect(ids(changed)).toEqual(['m003', 'm002', 'm001']);
    expect(changed.messages[1]).toBe(tick);
    expect(changed.messages[0]).toBe(added.messages[0]);
    expect(changed.messages[2]).toBe(added.messages[2]);
  });

  it('sorts a message that arrives out of order', () => {
    const thread = upsertMessage(read([1, 3], true), message(2));
    expect(ids(thread)).toEqual(['m003', 'm002', 'm001']);
  });

  it('ignores a change to a message older than the loaded page (no gap)', () => {
    const thread = read([5, 6], false);
    expect(upsertMessage(thread, message(1, { state: 'read' }))).toBe(thread);
    // Once the store has nothing older, everything belongs.
    expect(ids(upsertMessage(read([5, 6], true), message(1)))).toEqual(['m006', 'm005', 'm001']);
  });

  it('removes deleted messages, and returns the same thread when none are here', () => {
    const thread = read([1, 2, 3], true);
    expect(ids(removeMessages(thread, ['m002']))).toEqual(['m003', 'm001']);
    expect(removeMessages(thread, ['nope'])).toBe(thread);
  });

  it('lets events seen while the store was read win, and drops ones older than the page', () => {
    const tick = message(3, { state: 'read' });
    const events = upsertMessage(upsertMessage(EMPTY_THREAD, message(1)), tick);
    expect(events.complete).toBe(false);
    const thread = withNewestPage(events, page(2, 3, 4), false);
    expect(ids(thread)).toEqual(['m004', 'm003', 'm002']);
    expect(thread.byId.get('m003')).toBe(tick);
    expect(thread.complete).toBe(true);
  });

  it('adds older pages at the end, and trims back to the newest page', () => {
    const thread = withOlderPage(read([4, 5], false), page(2, 3), true);
    expect(ids(thread)).toEqual(['m005', 'm004', 'm003', 'm002']);
    expect(thread.exhausted).toBe(true);
    const trimmed = trimThread(thread, 2);
    expect(ids(trimmed)).toEqual(['m005', 'm004']);
    expect(trimmed.exhausted).toBe(false);
    expect([...trimmed.byId.keys()]).toEqual(['m005', 'm004']);
    expect(trimThread(trimmed, 2)).toBe(trimmed);
  });
});
