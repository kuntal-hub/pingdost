import { describe, expect, it } from 'vitest';

import {
  applyOp,
  applyPending,
  canDeleteForEveryone,
  canEdit,
  isValidReaction,
  summarizeReactions,
  type Op,
} from './ops';
import { messageRecord, testId } from '../testing/store-contract';

const HOUR = 3_600_000;
const rules = { editWindowMs: 24 * HOUR, deleteWindowMs: 24 * HOUR };
const alice = testId();
const bob = testId();

function target() {
  return messageRecord({ senderUserId: alice, sentAt: 1_000, body: 'original' });
}

function op(message: ReturnType<typeof target>, overrides: Partial<Op>): Op {
  return {
    opId: testId(),
    type: 'edit',
    targetMessageId: message.messageId,
    conversationId: message.conversationId,
    senderUserId: alice,
    sentAt: 2_000,
    body: 'edited',
    remove: false,
    ...overrides,
  };
}

describe('edits', () => {
  it('replaces the text when the sender edits inside the window, keeping no history', () => {
    const message = target();
    const edit = op(message, {});
    expect(applyOp(message, edit, rules)).toEqual({
      ...message,
      body: 'edited',
      editedAt: 2_000,
      editId: edit.opId,
    });
  });

  it('refuses edits by anyone else, after the window, empty, or of another conversation', () => {
    const message = target();
    expect(applyOp(message, op(message, { senderUserId: bob }), rules)).toBeUndefined();
    expect(applyOp(message, op(message, { sentAt: 1_000 + 24 * HOUR + 1 }), rules)).toBeUndefined();
    expect(applyOp(message, op(message, { body: '  ' }), rules)).toBeUndefined();
    expect(applyOp(message, op(message, { conversationId: testId() }), rules)).toBeUndefined();
    expect(applyOp(message, op(message, { targetMessageId: testId() }), rules)).toBeUndefined();
    const notice = { ...message, kind: 'system' as const };
    expect(applyOp(notice, op(notice, {}), rules)).toBeUndefined();
  });

  it('keeps the newest edit whatever order the edits arrive in', () => {
    const message = target();
    const early = op(message, { sentAt: 2_000, body: 'first' });
    const late = op(message, { sentAt: 3_000, body: 'second' });
    const forward = applyPending(message, [], rules);
    expect(forward).toEqual(message);
    const inOrder = applyOp(applyOp(message, early, rules)!, late, rules)!;
    const reversed = applyOp(message, late, rules)!;
    expect(applyOp(reversed, early, rules)).toBeUndefined();
    expect(inOrder.body).toBe('second');
    expect(reversed.body).toBe('second');
    // Same time: the larger op ID wins, everywhere.
    const [a, b] = [testId(), testId()].sort();
    const tieA = op(message, { sentAt: 3_000, opId: a!, body: 'a' });
    const tieB = op(message, { sentAt: 3_000, opId: b!, body: 'b' });
    expect(applyOp(applyOp(message, tieA, rules)!, tieB, rules)?.body).toBe('b');
    expect(applyOp(applyOp(message, tieB, rules)!, tieA, rules)).toBeUndefined();
  });
});

describe('delete for everyone', () => {
  it('turns the message into a tombstone that nothing changes afterwards', () => {
    const message = {
      ...target(),
      reactions: [{ userId: bob, emoji: '👍', at: 1_500, id: testId() }],
    };
    const deleted = applyOp(message, op(message, { type: 'delete', body: '' }), rules)!;
    expect(deleted).toMatchObject({ kind: 'deleted', body: '', reactions: [], deletedAt: 2_000 });
    expect(applyOp(deleted, op(deleted, { sentAt: 9_000, body: 'back' }), rules)).toBeUndefined();
    expect(
      applyOp(deleted, op(deleted, { type: 'reaction', senderUserId: bob, body: '❤️' }), rules),
    ).toBeUndefined();
    expect(applyOp(deleted, op(deleted, { type: 'delete' }), rules)).toBeUndefined();
  });

  it('is only for the sender, inside the window', () => {
    const message = target();
    expect(
      applyOp(message, op(message, { type: 'delete', senderUserId: bob }), rules),
    ).toBeUndefined();
    expect(
      applyOp(message, op(message, { type: 'delete', sentAt: 1_000 + 25 * HOUR }), rules),
    ).toBeUndefined();
    expect(canDeleteForEveryone(message, alice, rules, 2_000)).toBe(true);
    expect(canDeleteForEveryone(message, bob, rules, 2_000)).toBe(false);
    expect(canEdit(message, alice, rules, 1_000 + 25 * HOUR)).toBe(false);
  });
});

describe('reactions', () => {
  it('keeps one reaction per user; the newest event wins, a withdrawal included', () => {
    const message = target();
    const like = op(message, { type: 'reaction', senderUserId: bob, body: '👍', sentAt: 2_000 });
    const heart = op(message, { type: 'reaction', senderUserId: bob, body: '❤️', sentAt: 3_000 });
    const withdraw = op(message, {
      type: 'reaction',
      senderUserId: bob,
      body: '',
      remove: true,
      sentAt: 4_000,
    });
    const own = op(message, { type: 'reaction', body: '👍', sentAt: 2_500 });

    const liked = applyOp(applyOp(message, like, rules)!, own, rules)!;
    const changed = applyOp(liked, heart, rules)!;
    expect(summarizeReactions(changed.reactions, alice)).toEqual([
      { emoji: '👍', count: 1, mine: true, userIds: [alice] },
      { emoji: '❤️', count: 1, mine: false, userIds: [bob] },
    ]);
    const withdrawn = applyOp(changed, withdraw, rules)!;
    expect(withdrawn.reactions.find((r) => r.userId === bob)?.emoji).toBeNull();
    // An older event arriving late cannot bring the reaction back.
    expect(applyOp(withdrawn, like, rules)).toBeUndefined();
    expect(
      applyPending(
        message,
        [withdraw, heart, like].map((o) => ({ ...o, receivedAt: 1 })),
        rules,
      ).reactions,
    ).toEqual([{ userId: bob, emoji: null, at: 4_000, id: withdraw.opId }]);
  });

  it('accepts one short emoji token only', () => {
    expect(isValidReaction('👍')).toBe(true);
    expect(isValidReaction('👨‍👩‍👧‍👦')).toBe(true);
    expect(isValidReaction('🇮🇳')).toBe(true);
    expect(isValidReaction('')).toBe(false);
    expect(isValidReaction('a b')).toBe(false);
    expect(isValidReaction('x'.repeat(33))).toBe(false);
    const message = target();
    expect(
      applyOp(message, op(message, { type: 'reaction', body: 'two words' }), rules),
    ).toBeUndefined();
  });
});
