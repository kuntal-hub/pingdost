import { describe, expect, it } from 'vitest';

import { messageRecord } from '@pingdost/message-engine/testing';

import type { Names } from './labels';
import {
  copyText,
  deleteForEveryoneCheck,
  forwardable,
  forwardNotice,
  forwardTargets,
  MAX_FORWARD_TARGETS,
  pickTarget,
  selectable,
  selectedMessages,
  toggleSelected,
  type ForwardTarget,
} from './selection';
import { dayLabel, timeLabel } from './timeline';

const SELF = 'me';
const names: Names = { selfUserId: SELF, name: (id) => (id === 'asha' ? 'Asha' : 'Unknown') };
const rules = { editWindowMs: 15 * 60_000, deleteWindowMs: 24 * 3_600_000 };
const NOW = Date.UTC(2026, 10, 11, 12);

const photo = (overrides = {}) =>
  messageRecord({
    kind: 'attachment',
    body: '',
    attachment: {
      attachmentId: 'a',
      key: '',
      noncePrefix: '',
      plaintextSize: 1,
      chunkCount: 1,
      ciphertextSize: 17,
      mimeType: 'image/jpeg',
      fileName: null,
      ciphertextSha256: '',
      chunkHashListSha256: '',
      thumbnail: null,
    },
    ...overrides,
  });

describe('selecting', () => {
  it('toggles in the order of selecting, and leaves out notices', () => {
    expect(toggleSelected(toggleSelected([], 'b'), 'a')).toEqual(['b', 'a']);
    expect(toggleSelected(['b', 'a'], 'b')).toEqual(['a']);
    expect(selectable(messageRecord({ kind: 'system' }))).toBe(false);
    expect(selectable(messageRecord({ kind: 'deleted' }))).toBe(true);
  });

  it('lists the selection oldest first and drops messages no longer loaded', () => {
    const old = messageRecord({ sortAt: 1 });
    const recent = messageRecord({ sortAt: 2 });
    const loaded = new Map([old, recent].map((m) => [m.messageId, m]));
    expect(selectedMessages([recent.messageId, 'gone', old.messageId], loaded)).toEqual([
      old,
      recent,
    ]);
  });
});

describe('copyText', () => {
  it('copies one message as it is, line breaks included', () => {
    expect(copyText([messageRecord({ body: 'line one\nline two' })], names)).toBe(
      'line one\nline two',
    );
    expect(copyText([photo({ body: 'the view' })], names)).toBe('the view');
    expect(copyText([photo()], names)).toBe('Photo');
  });

  it('copies several as one line each, oldest first, with sender and time', () => {
    const at = NOW - 60_000;
    const mine = messageRecord({ body: 'see you\nsoon', sentAt: at + 1, sortAt: 2 });
    const theirs = messageRecord({
      body: 'hi',
      direction: 'in',
      senderUserId: 'asha',
      sentAt: at,
      sortAt: 1,
    });
    const gone = messageRecord({ kind: 'deleted', body: '', sortAt: 3 });
    expect(copyText([mine, gone, theirs], names)).toBe(
      `[${timeLabel(at)}] Asha: hi\n[${timeLabel(at + 1)}] You: see you soon`,
    );
  });

  it('adds the date when the messages span days', () => {
    const a = messageRecord({ body: 'a', sentAt: NOW - 3 * 86_400_000, sortAt: 1 });
    const b = messageRecord({ body: 'b', sentAt: NOW, sortAt: 2 });
    const lines = copyText([a, b], names).split('\n');
    expect(lines[0]).toBe(`[${dayLabel(a.sentAt)} ${timeLabel(a.sentAt)}] You: a`);
  });
});

describe('deleteForEveryoneCheck', () => {
  const own = (sentAt = NOW - 60_000) => messageRecord({ senderUserId: SELF, sentAt });

  it('allows own messages inside the window', () => {
    expect(deleteForEveryoneCheck([own(), own()], SELF, rules, NOW)).toEqual({ allowed: true });
  });

  it('says why not: someone else’s, too old, already deleted, nothing selected', () => {
    const theirs = messageRecord({ senderUserId: 'asha', direction: 'in' });
    expect(deleteForEveryoneCheck([own(), theirs], SELF, rules, NOW)).toEqual({
      allowed: false,
      reason: 'Only your own messages can be deleted for everyone',
    });
    expect(deleteForEveryoneCheck([own(), own(NOW - 25 * 3_600_000)], SELF, rules, NOW)).toEqual({
      allowed: false,
      reason: 'Messages older than 24 hours can only be deleted for you',
    });
    const deleted = messageRecord({ senderUserId: SELF, kind: 'deleted', sentAt: NOW });
    expect(deleteForEveryoneCheck([deleted], SELF, rules, NOW).allowed).toBe(false);
    expect(deleteForEveryoneCheck([], SELF, rules, NOW).allowed).toBe(false);
  });
});

describe('forwarding', () => {
  it('forwards text and files only', () => {
    expect(forwardable(messageRecord())).toBe(true);
    expect(forwardable(photo())).toBe(true);
    for (const kind of ['deleted', 'system', 'unsupported'] as const) {
      expect(forwardable(messageRecord({ kind })), kind).toBe(false);
    }
  });

  const target = (key: string, overrides: Partial<ForwardTarget> = {}): ForwardTarget => ({
    key,
    kind: 'direct',
    conversationId: key,
    userId: `u-${key}`,
    name: key,
    username: null,
    updatedAt: 0,
    ...overrides,
  });

  it('lists recent chats first, then circle members without a chat by name', () => {
    const chats = [
      target('old', { updatedAt: 1 }),
      target('Family', { kind: 'group', userId: null, updatedAt: 3 }),
      target('new', { updatedAt: 2 }),
    ];
    const people = [
      target('zed', { conversationId: null }),
      target('dup', { conversationId: null, userId: 'u-new' }),
      target('ann', { conversationId: null }),
    ];
    expect(forwardTargets(chats, people, '').map((t) => t.key)).toEqual([
      'Family',
      'new',
      'old',
      'ann',
      'zed',
    ]);
  });

  it('filters by name, username and group name', () => {
    const chats = [
      target('g', { kind: 'group', name: 'Weekend trip', userId: null }),
      target('a', { name: 'Asha Kapoor', username: 'asha_k' }),
    ];
    const people = [target('z', { name: 'Zoë', username: 'zed', conversationId: null })];
    expect(forwardTargets(chats, people, 'trip').map((t) => t.key)).toEqual(['g']);
    expect(forwardTargets(chats, people, '@asha').map((t) => t.key)).toEqual(['a']);
    expect(forwardTargets(chats, people, 'zoe').map((t) => t.key)).toEqual(['z']);
  });

  it(`picks up to ${MAX_FORWARD_TARGETS} targets`, () => {
    let picked: string[] = [];
    for (let i = 0; i < MAX_FORWARD_TARGETS; i++) {
      const next = pickTarget(picked, `t${i}`);
      expect(next).not.toBe(false);
      picked = next as string[];
    }
    expect(pickTarget(picked, 'one more')).toBe(false);
    expect(pickTarget(picked, 't0')).toEqual(picked.slice(1));
  });

  it('reports what was forwarded and what was skipped', () => {
    expect(forwardNotice({ sent: 1, missing: 0, failed: 0 })).toBe('Message forwarded');
    expect(forwardNotice({ sent: 3, missing: 1, failed: 0 })).toBe(
      '3 messages forwarded · 1 file is not on this device and was skipped',
    );
    expect(forwardNotice({ sent: 0, missing: 2, failed: 1 })).toBe(
      '2 files are not on this device and were skipped · 1 could not be forwarded',
    );
  });
});
