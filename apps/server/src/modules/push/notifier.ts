/**
 * Content-free push wakes (ARCHITECTURE A2, ADR 0015): `{"t":"wake"}` makes an offline device
 * connect and fetch its mailbox. `PushService` implements `PushNotifier` over the FCM and
 * Web Push senders; without either configured, wakes are dropped.
 */
import type { PushPayload } from '@pingdost/shared-types';

import type { PushTarget } from './repo';

export interface PushNotifier {
  /** Best effort and coalesced per device; never carries message data. */
  wake(deviceId: string, urgent: boolean): void;
}

export const noopPushNotifier: PushNotifier = { wake: () => undefined };

export type SendOutcome =
  | { result: 'sent' }
  /** The provider says the address will never work again: delete it. */
  | { result: 'invalid_token' }
  /** With `retryAfterMs` the failure is transient and the send may be retried. */
  | { result: 'failed'; status?: number; retryAfterMs?: number };

/** One push provider. Implementations never throw and never log the address. */
export interface PushSender {
  send(target: PushTarget, payload: PushPayload): Promise<SendOutcome>;
}

/** Parses a `Retry-After` header (seconds or an HTTP date) into milliseconds. */
export function retryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1_000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
