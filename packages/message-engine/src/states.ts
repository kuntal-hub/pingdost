/**
 * Message states (REQ §8.3, ARCHITECTURE A8). Each recipient device has its own state; the
 * message shows the best state among the recipient user's devices. The sender's own other
 * devices never count, so "delivered" means a device of the recipient sent an E2EE receipt.
 */
import { canTransition, type MessageState } from '@pingdost/shared-types';

import type { DeliveryRecord } from './store';

/** States that stay put until a receipt (or nothing) moves them. */
export const SETTLED_STATES: readonly MessageState[] = [
  'delivered_to_recipient_device',
  'read',
  'expired_undelivered',
];

/** Accepted by the server or a relay, but not yet confirmed by a recipient device. */
export const IN_FLIGHT_STATES: readonly MessageState[] = ['sent_to_server', 'relayed'];

/**
 * `to` if the transition table allows it, directly or through `sending` (a step the engine
 * may skip, e.g. when the first send of a fan-out already succeeded); otherwise `from`.
 */
export function advance(from: MessageState, to: MessageState): MessageState {
  if (from === to) return from;
  if (canTransition(from, to)) return to;
  if (canTransition(from, 'sending') && canTransition('sending', to)) return to;
  return from;
}

/**
 * The message state from its per-device states. Only the recipient's devices count; with
 * none yet (the fan-out has not run), the message keeps `current`.
 */
export function aggregateState(
  current: MessageState,
  deliveries: readonly DeliveryRecord[],
): MessageState {
  const states = new Set(deliveries.filter((d) => !d.own).map((d) => d.state));
  if (states.size === 0) return current;
  if (states.has('read')) return 'read';
  if (states.has('delivered_to_recipient_device')) return 'delivered_to_recipient_device';
  if (current === 'expired_undelivered') return current;
  if (states.has('sent_to_server')) return 'sent_to_server';
  if (states.has('relayed')) return 'relayed';
  if (states.has('sending')) return 'sending';
  if (states.has('local_queued')) return 'local_queued';
  if (states.has('waiting_for_nearby_route')) return 'waiting_for_nearby_route';
  if (states.has('failed')) return 'failed';
  return 'expired_undelivered';
}

/** The new message state, kept legal: an illegal aggregate leaves the state unchanged. */
export function nextMessageState(
  current: MessageState,
  deliveries: readonly DeliveryRecord[],
): MessageState {
  return advance(current, aggregateState(current, deliveries));
}
