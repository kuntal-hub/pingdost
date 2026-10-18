import { z } from 'zod';

/**
 * The state of an outgoing message, named exactly as REQ §8.3 (ARCHITECTURE A8).
 *
 * - `sent_to_server` follows the server's `Accepted`; `relayed` follows a mesh relay's
 *   MeshAck. Neither is delivery.
 * - `delivered_to_recipient_device` and `read` follow only an E2EE `Receipt` from the
 *   recipient device.
 * - `expired_undelivered` is computed locally: no delivered receipt by created + max
 *   retention (ARCHITECTURE A3).
 */
export const MessageStateSchema = z.enum([
  'local_queued',
  'sending',
  'sent_to_server',
  'waiting_for_nearby_route',
  'relayed',
  'delivered_to_recipient_device',
  'read',
  'expired_undelivered',
  'failed',
]);

export type MessageState = z.infer<typeof MessageStateSchema>;
/** `MessageState.sent_to_server` etc. */
export const MessageState = MessageStateSchema.enum;

/**
 * Legal transitions. A receipt is proof of delivery, so it may move a message to
 * `delivered_to_recipient_device` or `read` from any state that is not already there, even
 * `expired_undelivered` (a late receipt). Nothing leaves `read`.
 */
export const MESSAGE_STATE_TRANSITIONS: Readonly<Record<MessageState, readonly MessageState[]>> = {
  // In the outbox. No connection yet → waiting for a nearby route; too old → expired.
  local_queued: ['sending', 'waiting_for_nearby_route', 'expired_undelivered', 'failed'],
  // Handed to a transport. A failed attempt goes back to the queue.
  sending: [
    'local_queued',
    'sent_to_server',
    'waiting_for_nearby_route',
    'relayed',
    'delivered_to_recipient_device',
    'read',
    'failed',
  ],
  sent_to_server: ['delivered_to_recipient_device', 'read', 'expired_undelivered'],
  // A route appeared (nearby peer or Internet) → sending; or a relay/recipient took it.
  waiting_for_nearby_route: [
    'sending',
    'relayed',
    'delivered_to_recipient_device',
    'read',
    'expired_undelivered',
    'failed',
  ],
  // Internet came back: the message may also go through the server.
  relayed: ['sending', 'delivered_to_recipient_device', 'read', 'expired_undelivered'],
  delivered_to_recipient_device: ['read'],
  read: [],
  expired_undelivered: ['delivered_to_recipient_device', 'read'],
  // The user retries.
  failed: ['local_queued', 'sending'],
};

export function canTransition(from: MessageState, to: MessageState): boolean {
  return MESSAGE_STATE_TRANSITIONS[from].includes(to);
}
