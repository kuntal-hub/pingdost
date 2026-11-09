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

/**
 * Whether a system message says the contact's safety number changed, and so asks to verify it
 * again. "Moved to a new phone" keeps the same number, and must not raise that alarm.
 */
export function isSafetyNumberChange(message: Pick<MessageRecord, 'kind' | 'body'>): boolean {
  return message.kind === 'system' && message.body === 'safety_number_changed';
}

/** A system message as a sentence: a changed safety number, or a group event (ADR 0016). */
export function systemText(message: MessageRecord, names?: Names): string {
  const who = (userId: string) =>
    names && userId === names.selfUserId ? 'You' : (names?.name(userId) ?? 'Someone');
  if (message.body === 'primary_device_changed') {
    // ADR 0022: same account key on a new phone, so the safety number is the same.
    return `${names ? who(message.senderUserId) : 'This contact'} moved to a new phone. The safety number is unchanged.`;
  }
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

/** What an attachment is; each app draws its own icon for it. */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

/** An attachment's type and a word for it; other files go by their name. */
export function attachmentType(message: Pick<MessageRecord, 'attachment'>): {
  kind: AttachmentKind;
  name: string;
} {
  const mime = message.attachment?.mimeType ?? '';
  if (mime.startsWith('image/')) return { kind: 'image', name: 'Photo' };
  if (mime.startsWith('video/')) return { kind: 'video', name: 'Video' };
  if (mime.startsWith('audio/')) return { kind: 'audio', name: 'Audio' };
  return { kind: 'file', name: message.attachment?.fileName ?? 'File' };
}

/** One line for an attachment message: its caption, or else what it is. */
export function attachmentText(message: Pick<MessageRecord, 'attachment' | 'body'>): string {
  const { name } = attachmentType(message);
  const caption = message.body.replace(/\s+/g, ' ').trim();
  return caption || name;
}

/**
 * One emoji as people see it: a flag (two regional indicators), a keycap (1️⃣), or a pictograph
 * with its variation selector, skin tone or tag characters (subdivision flags such as Scotland's),
 * joined by zero-width joiners
 * into one picture (👩‍👩‍👧, ❤️‍🔥).
 */
const ONE_EMOJI = new RegExp(
  String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic}[\u{FE0F}\p{Emoji_Modifier}\u{E0020}-\u{E007F}]*(?:\u{200D}\p{Extended_Pictographic}[\u{FE0F}\p{Emoji_Modifier}]*)*)$`,
  'u',
);

/**
 * A message that is exactly one emoji (Phase 35): shown large, without a bubble. Two or more
 * emoji, or any text, show at normal size.
 */
export function isBigEmoji(text: string): boolean {
  return ONE_EMOJI.test(text.trim());
}

const RTL_START = /^[^\p{L}]*[\u{0590}-\u{08FF}\u{FB1D}-\u{FDFF}\u{FE70}-\u{FEFF}]/u;

/** Whether the text's first letter is Hebrew, Arabic or another right-to-left script. */
export function startsRightToLeft(text: string): boolean {
  return RTL_START.test(text);
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
    case 'attachment':
      return attachmentText(message);
    case 'text':
      return message.body.replace(/\s+/g, ' ').trim();
  }
}

/** Which status mark to draw; each app maps it to an icon. Ticks follow the common convention. */
export type StateIcon = 'pending' | 'sent' | 'delivered' | 'read' | 'expired' | 'failed';

export interface StateLabel {
  /** Under the bubble. */
  short: string;
  /** Message info and screen readers. */
  long: string;
  icon: StateIcon;
  tone: 'muted' | 'success' | 'danger';
}

/**
 * The state to show. Read receipts are reciprocal (ADR 0014): with them off, "read" shows as
 * delivered.
 */
export function shownState(state: MessageState, readReceipts: boolean): MessageState {
  return state === 'read' && !readReceipts ? 'delivered_to_recipient_device' : state;
}

/** "Forwarded by 2 devices — not yet delivered." (REQ §11.6), with how the mesh delivers. */
export function relayedLabel(relays?: number): string {
  const who =
    relays === undefined || relays < 1
      ? 'a nearby device'
      : relays === 1
        ? '1 device'
        : `${relays} devices`;
  return `Forwarded by ${who} — not yet delivered. Over the mesh it arrives only when a path to the recipient appears.`;
}

/**
 * `via`: the path that carried it (ADR 0024). Over Bluetooth the next hop is the recipient's
 * own phone, but only its E2EE receipt makes the message delivered. `relays`: how many
 * devices accepted it from this one over the mesh (ADR 0025).
 */
export function stateLabel(
  state: MessageState,
  online: boolean,
  via?: 'internet' | 'nearby' | 'mesh',
  relays?: number,
): StateLabel {
  switch (state) {
    case 'local_queued':
      return {
        short: 'Queued',
        long: online
          ? 'Queued on this device — sending shortly.'
          : 'Queued on this device — waiting for a connection.',
        icon: 'pending',
        tone: 'muted',
      };
    case 'waiting_for_nearby_route':
      return {
        short: 'Queued',
        long: 'Queued on this device — waiting for a nearby route.',
        icon: 'pending',
        tone: 'muted',
      };
    case 'sending':
      return {
        short: 'Sending…',
        long: online ? 'Sending to the server.' : 'Sending over Bluetooth.',
        icon: 'pending',
        tone: 'muted',
      };
    case 'sent_to_server':
      return {
        short: 'Sent',
        long:
          via === 'nearby'
            ? "Sent over Bluetooth to the recipient's phone — not yet delivered: waiting for its delivery receipt."
            : via === 'internet' || online
              ? 'Sent to the server — not yet delivered to the recipient.'
              : // Offline with the path unknown (a chat bubble): it may have gone over Bluetooth.
                'Sent — not yet delivered: waiting for its delivery receipt.',
        icon: 'sent',
        tone: 'muted',
      };
    case 'relayed':
      return {
        short: 'Forwarded',
        long: relayedLabel(relays),
        icon: 'sent',
        tone: 'muted',
      };
    case 'delivered_to_recipient_device':
      return {
        short: 'Delivered',
        long: "Delivered to the recipient's device.",
        icon: 'delivered',
        tone: 'muted',
      };
    case 'read':
      return { short: 'Read', long: 'Read by the recipient.', icon: 'read', tone: 'success' };
    case 'expired_undelivered':
      return {
        short: 'Expired before delivery',
        // No receipt by the deadline: offline too long, or delivery receipts are off there.
        long: 'Expired before delivery: no delivery receipt came back in time. The recipient was offline too long, or does not send delivery receipts.',
        icon: 'expired',
        tone: 'danger',
      };
    case 'failed':
      return {
        short: 'Not sent · Tap to retry',
        long: 'Not sent. Tap the message to try again.',
        icon: 'failed',
        tone: 'danger',
      };
  }
}
