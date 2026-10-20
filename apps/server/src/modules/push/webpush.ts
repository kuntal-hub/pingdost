/**
 * Web Push sender (RFC 8030 + VAPID, via `web-push`; ADR 0015). The browser's push service
 * only relays the encrypted `{"t":"wake"}`; the `topic` makes queued wakes replace each other.
 * Phase 17 adds the web client's subscription.
 */
import webpush from 'web-push';

import type { PushPayload } from '@pingdost/shared-types';

import { retryAfterMs, type PushSender, type SendOutcome } from './notifier';
import type { PushTarget } from './repo';

export interface WebPushSenderOptions {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  /** `mailto:` or `https:` contact for the push services. */
  subject: string;
  ttlSeconds: number;
  timeoutMs?: number;
  /** Tests pass a fake; production uses `web-push`. */
  sendNotification?: typeof webpush.sendNotification;
}

export class WebPushSender implements PushSender {
  readonly #send: typeof webpush.sendNotification;

  constructor(private readonly options: WebPushSenderOptions) {
    this.#send = options.sendNotification ?? webpush.sendNotification.bind(webpush);
  }

  async send(target: PushTarget, payload: PushPayload): Promise<SendOutcome> {
    if (!target.keys) return { result: 'invalid_token' };
    const { vapidPublicKey, vapidPrivateKey, subject, ttlSeconds } = this.options;
    try {
      await this.#send({ endpoint: target.address, keys: target.keys }, JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: vapidPublicKey, privateKey: vapidPrivateKey },
        TTL: ttlSeconds,
        urgency: 'high',
        topic: payload.t,
        timeout: this.options.timeoutMs ?? 10_000,
      });
      return { result: 'sent' };
    } catch (error) {
      if (!(error instanceof webpush.WebPushError))
        return { result: 'failed', retryAfterMs: 1_000 };
      const status = error.statusCode;
      // 404/410: the subscription expired or the user revoked it.
      if (status === 404 || status === 410) return { result: 'invalid_token' };
      if (status === 429 || status >= 500) {
        const header = (error.headers as Record<string, string | undefined>)['retry-after'];
        return {
          result: 'failed',
          status,
          retryAfterMs: retryAfterMs(header, Date.now()) ?? 1_000,
        };
      }
      return { result: 'failed', status };
    }
  }
}
