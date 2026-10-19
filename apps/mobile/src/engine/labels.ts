// What each message state is called in the UI (REQ §8.3, §11.6; ARCHITECTURE A8). Never
// "delivered" for a server or relay hop: only a receipt from the recipient's device says so.
import type { MessageState } from '@pingdost/shared-types';

export interface StateLabel {
  /** Under the bubble. */
  short: string;
  /** Message info and screen readers. */
  long: string;
  /** A plain glyph; the tick marks follow the common convention. */
  glyph: string;
  tone: 'muted' | 'success' | 'danger';
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
        long: 'Expired before delivery: the recipient was offline for too long.',
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
