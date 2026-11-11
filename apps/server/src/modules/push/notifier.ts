/**
 * Content-free push wakes (ARCHITECTURE A2, ADR 0015): `{"t":"wake"}` makes an offline device
 * connect and fetch its mailbox. `PushService` implements `PushNotifier` over the FCM, Web Push
 * and APNs senders; a device whose provider is not configured is not woken.
 */
import type { PushPayload } from '@pingdost/shared-types';

import type { PushTarget } from './repo';

export interface PushNotifier {
  /** Best effort and coalesced per device; never carries message data. */
  wake(deviceId: string, urgent: boolean): void;
  /**
   * An E2EE call invite could not reach this offline device (ADR 0028): a content-free `call`
   * push, at most one per device per call-push window. The caller keeps re-sending the invite.
   */
  ring(deviceId: string): void;
  /** A circle request arrived or was accepted (Phase 37): a content-free `circle` push. */
  circle(deviceId: string): void;
}

export const noopPushNotifier: PushNotifier = {
  wake: () => undefined,
  ring: () => undefined,
  circle: () => undefined,
};

export type SendOutcome =
  | { result: 'sent' }
  /**
   * The provider says the address will never work again: delete it. `voip`: it was the
   * target's APNs VoIP token, so only that one goes.
   */
  | { result: 'invalid_token'; voip?: true }
  /** With `retryAfterMs` the failure is transient and the send may be retried. */
  | { result: 'failed'; status?: number; retryAfterMs?: number };

/** One push provider. Implementations never throw and never log the address. */
export interface PushSender {
  send(target: PushTarget, payload: PushPayload): Promise<SendOutcome>;
  /** Closes open connections (APNs keeps an HTTP/2 session). */
  close?(): Promise<void>;
}

/** A call push older than a ring is useless: the provider drops it after this. */
export const CALL_PUSH_TTL_SECONDS = 60;

/** The provider TTL for a payload: wakes live as long as the mailbox keeps mail. */
export function pushTtlSeconds(payload: PushPayload, ttlSeconds: number): number {
  return payload.t === 'call' ? Math.min(ttlSeconds, CALL_PUSH_TTL_SECONDS) : ttlSeconds;
}

/** Parses a `Retry-After` header (seconds or an HTTP date) into milliseconds. */
export function retryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1_000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
