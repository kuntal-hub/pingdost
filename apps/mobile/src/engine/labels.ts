// What each message state is called in the UI (REQ §8.3, §11.6; ARCHITECTURE A8). Never
// "delivered" for a server or relay hop: only a receipt from the recipient's device says so.
import { parseGroupNotice, type MessageRecord } from '@pingdost/message-engine';
import type { MessageState } from '@pingdost/shared-types';

/** How to name people in notices: a contact name, and who "you" are. */
export interface Names {
  name: (userId: string) => string;
  selfUserId: string;
}

function list(users: string[], who: (userId: string) => string): string {
  const named = users.map(who);
  if (named.length <= 1) return named[0] ?? 'someone';
  return `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

/** A system message as a sentence: a changed safety number, or a group event (ADR 0016). */
export function systemText(message: MessageRecord, names?: Names): string {
  const who = (userId: string) =>
    names && userId === names.selfUserId ? 'You' : (names?.name(userId) ?? 'Someone');
  const notice = parseGroupNotice(message.body);
  if (!notice) {
    return names && message.senderUserId !== names.selfUserId
      ? `Safety number changed for ${who(message.senderUserId)}`
      : 'Safety number changed';
  }
  switch (notice.type) {
    case 'created':
      return `${who(notice.by)} created the group`;
    case 'joined':
      return `${who(notice.by)} added you`;
    case 'added':
      return `${who(notice.by)} added ${list(notice.users, who)}`;
    case 'removed':
      return `${who(notice.by)} removed ${list(notice.users, (id) => (id === names?.selfUserId ? 'you' : who(id)))}`;
    case 'left':
      return `${list(notice.users, who)} left`;
    case 'role':
      return notice.role === 'admin'
        ? `${who(notice.by)} made ${list(notice.users, who)} an admin`
        : `${who(notice.by)} removed admin rights from ${list(notice.users, who)}`;
    case 'info':
      return `${who(notice.by)} changed the group info`;
    case 'not_member':
      return "You're no longer a member of this group";
  }
}

/** One line standing for a message: previews, quotes, search results. */
export function previewText(message: MessageRecord, names?: Names): string {
  switch (message.kind) {
    case 'deleted':
      return 'This message was deleted';
    case 'system':
      return systemText(message, names);
    case 'unsupported':
      return 'Update PingDost to see this message';
    case 'text':
      return message.body.replace(/\s+/g, ' ').trim();
  }
}

export interface StateLabel {
  /** Under the bubble. */
  short: string;
  /** Message info and screen readers. */
  long: string;
  /** A plain glyph; the tick marks follow the common convention. */
  glyph: string;
  tone: 'muted' | 'success' | 'danger';
}

/**
 * The state to show. Read receipts are reciprocal (ADR 0014): with them off, "read" shows as
 * delivered.
 */
export function shownState(state: MessageState, readReceipts: boolean): MessageState {
  return state === 'read' && !readReceipts ? 'delivered_to_recipient_device' : state;
}

export function stateLabel(state: MessageState, online: boolean): StateLabel {
  switch (state) {
    case 'local_queued':
      return {
        short: 'Queued',
        long: online
          ? 'Queued on this device — sending shortly.'
          : 'Queued on this device — waiting for a connection.',
        glyph: '◷',
        tone: 'muted',
      };
    case 'waiting_for_nearby_route':
      return {
        short: 'Queued',
        long: 'Queued on this device — waiting for a nearby route.',
        glyph: '◷',
        tone: 'muted',
      };
    case 'sending':
      return { short: 'Sending…', long: 'Sending to the server.', glyph: '◷', tone: 'muted' };
    case 'sent_to_server':
      return {
        short: 'Sent',
        long: 'Sent to the server — not yet delivered to the recipient.',
        glyph: '✓',
        tone: 'muted',
      };
    case 'relayed':
      return {
        short: 'Forwarded',
        long: 'Forwarded by a nearby device — not yet delivered.',
        glyph: '✓',
        tone: 'muted',
      };
    case 'delivered_to_recipient_device':
      return {
        short: 'Delivered',
        long: "Delivered to the recipient's device.",
        glyph: '✓✓',
        tone: 'muted',
      };
    case 'read':
      return { short: 'Read', long: 'Read by the recipient.', glyph: '✓✓', tone: 'success' };
    case 'expired_undelivered':
      return {
        short: 'Expired before delivery',
        // No receipt by the deadline: offline too long, or delivery receipts are off there.
        long: 'Expired before delivery: no delivery receipt came back in time. The recipient was offline too long, or does not send delivery receipts.',
        glyph: '⌛',
        tone: 'danger',
      };
    case 'failed':
      return {
        short: 'Not sent · Tap to retry',
        long: 'Not sent. Tap the message to try again.',
        glyph: '!',
        tone: 'danger',
      };
  }
}
