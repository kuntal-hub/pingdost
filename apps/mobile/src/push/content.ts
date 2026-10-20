// What a local message notification says (Phase 12, ADR 0015). The push itself carried nothing:
// the phone fetched and decrypted the message, and builds this text on the device. Pure, so it
// is unit-tested in Node.
import { z } from 'zod';

import type { ConversationRecord, MessageRecord } from '@pingdost/message-engine';

/** Settings → Notifications; local to this phone. */
export const NotificationPrefsSchema = z.object({
  /** Show the message text; when off, "New message". */
  showPreviews: z.boolean(),
  /** Show "PingDost" instead of the sender's name. */
  hideSender: z.boolean(),
  /** The user dismissed the "turn on notifications" card. */
  promptDismissed: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  showPreviews: true,
  hideSender: false,
  promptDismissed: false,
};

const PREVIEW_MAX = 200;

/** Whether a received message gets a notification. */
export function shouldNotify(input: {
  message: Pick<MessageRecord, 'direction' | 'readAt' | 'kind'>;
  conversation: Pick<ConversationRecord, 'mutedUntil'> | undefined;
  /** The app is on screen: the chat list and the open chat show it instead. */
  appActive: boolean;
  now: number;
}): boolean {
  const { message, conversation, appActive, now } = input;
  if (appActive || message.direction !== 'in' || message.readAt !== null) return false;
  if (message.kind === 'deleted' || message.kind === 'system') return false;
  const mutedUntil = conversation?.mutedUntil ?? null;
  return mutedUntil === null || mutedUntil <= now;
}

/**
 * The title and text for the newest unread message of a chat. In a group the title is the
 * group's name and the text names the sender.
 */
export function notificationContent(input: {
  senderName: string;
  groupName?: string;
  message: Pick<MessageRecord, 'kind' | 'body'>;
  unreadCount: number;
  prefs: Pick<NotificationPrefs, 'showPreviews' | 'hideSender'>;
}): { title: string; body: string } {
  const { senderName, groupName, message, unreadCount, prefs } = input;
  const title = prefs.hideSender ? 'PingDost' : (groupName ?? senderName);
  if (!prefs.showPreviews) {
    return { title, body: unreadCount > 1 ? `${unreadCount} new messages` : 'New message' };
  }
  let text =
    message.kind === 'text'
      ? truncate(message.body.replace(/\s+/g, ' ').trim(), PREVIEW_MAX)
      : 'New message (update PingDost to read it)';
  if (groupName !== undefined && !prefs.hideSender) text = `${senderName}: ${text}`;
  return { title, body: unreadCount > 1 ? `${text} · ${unreadCount} new messages` : text };
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}
