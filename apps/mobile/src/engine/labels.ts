// What each message state is called in the UI (REQ §8.3, §11.6; ARCHITECTURE A8). Never
// "delivered" for a server or relay hop: only a receipt from the recipient's device says so.
import type { MessageRecord } from '@pingdost/message-engine';
import type { MessageState } from '@pingdost/shared-types';

/** One line standing for a message: previews, quotes, search results. */
export function previewText(message: MessageRecord): string {
  switch (message.kind) {
    case 'deleted':
      return 'This message was deleted';
    case 'system':
      return 'Safety number changed';
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
