// Selecting several messages (Phase 39, ADR 0043), the same on the phone and the web: what can be
// selected, copied, deleted for everyone and forwarded, and where a forward can go.
import {
  canDeleteForEveryone,
  MAX_FORWARD_TARGETS,
  type MessageRecord,
  type OpRules,
} from '@pingdost/message-engine';

import { attachmentText, type Names } from './labels';
import { matchesPerson, togglePicked } from './people';
import { dayLabel, timeLabel } from './timeline';

export { MAX_FORWARD_TARGETS };

/** Notices the app adds (safety numbers, group events) are not messages anyone sent. */
export function selectable(message: MessageRecord): boolean {
  return message.kind !== 'system';
}

/** Adds or removes a message, keeping the order of selecting. */
export function toggleSelected(selected: readonly string[], messageId: string): string[] {
  return togglePicked(selected, messageId);
}

function byTime(a: MessageRecord, b: MessageRecord): number {
  return a.sortAt - b.sortAt || (a.messageId < b.messageId ? -1 : 1);
}

/** The selected messages still loaded, oldest first (a message deleted meanwhile drops out). */
export function selectedMessages(
  selected: readonly string[],
  loaded: ReadonlyMap<string, MessageRecord>,
): MessageRecord[] {
  return selected
    .map((id) => loaded.get(id))
    .filter((m): m is MessageRecord => m !== undefined && selectable(m))
    .sort(byTime);
}

/** Text and files (their caption or kind); deleted and unsupported messages have nothing. */
export function copyable(message: MessageRecord): boolean {
  return message.kind === 'text' || message.kind === 'attachment';
}

function senderName(message: MessageRecord, names?: Names): string {
  if (message.direction === 'out') return 'You';
  return names?.name(message.senderUserId) ?? 'Someone';
}

/**
 * What Copy puts on the clipboard: one message's own text, or one line per message, oldest first,
 * as "[time] Sender: text" (the date is added when the messages span more than one day).
 */
export function copyText(messages: readonly MessageRecord[], names?: Names): string {
  const sorted = messages.filter(copyable).sort(byTime);
  const only = sorted.length === 1 ? sorted[0] : undefined;
  if (only) return only.kind === 'text' ? only.body : attachmentText(only);
  const days = new Set(sorted.map((m) => new Date(m.sentAt).toDateString()));
  return sorted
    .map((m) => {
      const time =
        days.size > 1 ? `${dayLabel(m.sentAt)} ${timeLabel(m.sentAt)}` : timeLabel(m.sentAt);
      const text = m.kind === 'text' ? m.body.replace(/\s+/g, ' ').trim() : attachmentText(m);
      return `[${time}] ${senderName(m, names)}: ${text}`;
    })
    .join('\n');
}

export type DeleteForEveryone = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether every selected message can be deleted for everyone; otherwise why not, so the app can
 * offer only "Delete for me" and say so.
 */
export function deleteForEveryoneCheck(
  messages: readonly MessageRecord[],
  selfUserId: string,
  rules: OpRules,
  now: number,
): DeleteForEveryone {
  if (messages.length === 0) return { allowed: false, reason: 'Nothing is selected' };
  if (messages.some((m) => m.kind === 'deleted' || m.kind === 'system')) {
    return { allowed: false, reason: 'Some of these messages are already deleted' };
  }
  if (messages.some((m) => m.senderUserId !== selfUserId)) {
    return { allowed: false, reason: 'Only your own messages can be deleted for everyone' };
  }
  if (messages.some((m) => !canDeleteForEveryone(m, selfUserId, rules, now))) {
    const hours = Math.round(rules.deleteWindowMs / 3_600_000);
    return {
      allowed: false,
      reason: `Messages older than ${hours} hours can only be deleted for you`,
    };
  }
  return { allowed: true };
}

/** Text and files can be forwarded; a file needs its local copy, which the app checks. */
export function forwardable(message: MessageRecord): boolean {
  return message.kind === 'text' || (message.kind === 'attachment' && message.attachment != null);
}

/** A chat to forward to, or a circle member without a chat yet (opened on Send). */
export interface ForwardTarget {
  /** The conversation ID, or `user:<userId>` for a person without a chat. */
  key: string;
  kind: 'direct' | 'group';
  conversationId: string | null;
  /** The other person of a direct chat. */
  userId: string | null;
  name: string;
  username: string | null;
  /** Last activity; 0 for a person without a chat. */
  updatedAt: number;
}

/**
 * The forward sheet's list: chats first, most recent on top, then circle members without a chat
 * by name; filtered by `query` like people search (a group by its name).
 */
export function forwardTargets(
  chats: readonly ForwardTarget[],
  people: readonly ForwardTarget[],
  query: string,
): ForwardTarget[] {
  const withChat = new Set(
    chats.flatMap((c) => (c.kind === 'direct' && c.userId ? [c.userId] : [])),
  );
  const matches = (t: ForwardTarget) =>
    matchesPerson({ userId: t.key, username: t.username, displayName: t.name }, query);
  const recent = chats.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt);
  const others = people
    .filter((p) => !(p.userId && withChat.has(p.userId)) && matches(p))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...recent, ...others];
}

/** Picks or unpicks a target; false when the limit is reached (the app says so). */
export function pickTarget(picked: readonly string[], key: string): string[] | false {
  if (!picked.includes(key) && picked.length >= MAX_FORWARD_TARGETS) return false;
  return togglePicked(picked, key);
}

/** The notice after forwarding. */
export function forwardNotice(result: { sent: number; missing: number; failed: number }): string {
  const parts: string[] = [];
  if (result.sent > 0) {
    parts.push(result.sent === 1 ? 'Message forwarded' : `${result.sent} messages forwarded`);
  }
  if (result.missing > 0) {
    parts.push(
      result.missing === 1
        ? '1 file is not on this device and was skipped'
        : `${result.missing} files are not on this device and were skipped`,
    );
  }
  if (result.failed > 0) {
    parts.push(
      result.failed === 1 ? '1 could not be forwarded' : `${result.failed} could not be forwarded`,
    );
  }
  return parts.join(' · ') || 'Nothing was forwarded';
}
