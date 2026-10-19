/**
 * Edits, deletes and reactions (REQ §8.1, §14.3; ADR 0014): small E2EE Contents that change
 * an earlier message. Every device applies them with the same rules, so all copies converge
 * whatever order the ops arrive in:
 * - **Edit:** only the original sender, within `editWindowMs` of sending; the newest edit
 *   wins (header time, then op ID). The new text replaces the old one: no device keeps an
 *   edit history.
 * - **Delete for everyone:** only the original sender, within `deleteWindowMs`. The message
 *   becomes a tombstone (text and reactions dropped); nothing changes it afterwards. It is
 *   best-effort: it cannot reach copies, screenshots, exports or notifications.
 * - **Reaction:** anyone in the conversation, one emoji per user; the newest event per user
 *   wins, and a withdrawal is kept so an older event cannot bring the reaction back.
 * An op whose target has not arrived is kept (`PendingOpRecord`) and applied on arrival.
 */
import type { MessageRecord, OpType, PendingOpRecord, ReactionEntry } from '../store';

export interface Op {
  opId: string;
  type: OpType;
  targetMessageId: string;
  conversationId: string;
  senderUserId: string;
  sentAt: number;
  /** Edit: the new text; reaction: the emoji. */
  body: string;
  /** Reaction: withdraw it. */
  remove: boolean;
}

export interface OpRules {
  editWindowMs: number;
  deleteWindowMs: number;
}

/** UTF-16 units in one reaction: enough for any emoji sequence (flags, families, skin tones). */
export const MAX_REACTION_LENGTH = 32;

/** A reaction is one short token: no spaces or line breaks. */
export function isValidReaction(emoji: string): boolean {
  return emoji.length > 0 && emoji.length <= MAX_REACTION_LENGTH && !/\s/.test(emoji);
}

/** Whether event (at, id) is newer than (otherAt, otherId). */
function newer(at: number, id: string, otherAt: number, otherId: string): boolean {
  return at > otherAt || (at === otherAt && id > otherId);
}

export function canEdit(message: MessageRecord, userId: string, rules: OpRules, now: number) {
  return (
    message.kind === 'text' &&
    message.senderUserId === userId &&
    now - message.sentAt <= rules.editWindowMs
  );
}

export function canDeleteForEveryone(
  message: MessageRecord,
  userId: string,
  rules: OpRules,
  now: number,
) {
  return (
    (message.kind === 'text' || message.kind === 'unsupported') &&
    message.senderUserId === userId &&
    now - message.sentAt <= rules.deleteWindowMs
  );
}

export function canReact(message: MessageRecord): boolean {
  return message.kind === 'text' || message.kind === 'unsupported';
}

/** The target after `op`, or undefined when the op is not allowed or changes nothing. */
export function applyOp(target: MessageRecord, op: Op, rules: OpRules): MessageRecord | undefined {
  if (op.targetMessageId !== target.messageId || op.conversationId !== target.conversationId) {
    return undefined;
  }
  switch (op.type) {
    case 'edit': {
      if (!canEdit(target, op.senderUserId, rules, op.sentAt)) return undefined;
      if (op.body.trim() === '') return undefined;
      if (
        target.editedAt !== null &&
        !newer(op.sentAt, op.opId, target.editedAt, target.editId ?? '')
      ) {
        return undefined;
      }
      return { ...target, body: op.body, editedAt: op.sentAt, editId: op.opId };
    }
    case 'delete': {
      if (!canDeleteForEveryone(target, op.senderUserId, rules, op.sentAt)) return undefined;
      return { ...target, kind: 'deleted', body: '', reactions: [], deletedAt: op.sentAt };
    }
    case 'reaction': {
      if (!canReact(target)) return undefined;
      if (!op.remove && !isValidReaction(op.body)) return undefined;
      const current = target.reactions.find((r) => r.userId === op.senderUserId);
      if (current && !newer(op.sentAt, op.opId, current.at, current.id)) return undefined;
      const entry: ReactionEntry = {
        userId: op.senderUserId,
        emoji: op.remove ? null : op.body,
        at: op.sentAt,
        id: op.opId,
      };
      return {
        ...target,
        reactions: [...target.reactions.filter((r) => r.userId !== op.senderUserId), entry],
      };
    }
  }
}

/** Applies pending ops to a message that just arrived, oldest first. */
export function applyPending(
  message: MessageRecord,
  ops: readonly PendingOpRecord[],
  rules: OpRules,
): MessageRecord {
  let current = message;
  const ordered = [...ops].sort(
    (a, b) => a.sentAt - b.sentAt || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0),
  );
  for (const op of ordered) current = applyOp(current, op, rules) ?? current;
  return current;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  /** This user is among them. */
  mine: boolean;
  userIds: string[];
}

/** Reactions grouped by emoji, the most used first (for the UI). */
export function summarizeReactions(
  reactions: readonly ReactionEntry[],
  selfUserId: string,
): ReactionSummary[] {
  const groups = new Map<string, ReactionSummary>();
  for (const reaction of [...reactions].sort((a, b) => a.at - b.at)) {
    if (reaction.emoji === null) continue;
    const group = groups.get(reaction.emoji) ?? {
      emoji: reaction.emoji,
      count: 0,
      mine: false,
      userIds: [],
    };
    group.count++;
    group.userIds.push(reaction.userId);
    if (reaction.userId === selfUserId) group.mine = true;
    groups.set(reaction.emoji, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
