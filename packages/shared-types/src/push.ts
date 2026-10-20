/**
 * Push wake registration: `PUT|DELETE /v1/push/token` (Phase 12, ADR 0015). A push only wakes
 * a device so it connects and fetches its mailbox: payloads never carry message data.
 */
import { z } from 'zod';

export const PushProviderSchema = z.enum(['fcm', 'webpush']);
export type PushProvider = z.infer<typeof PushProviderSchema>;

/** A browser `PushSubscription` (`toJSON()`), for Web Push with VAPID (RFC 8030/8291/8292). */
export const WebPushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/, error: 'must be an https URL' }).max(2_048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});
export type WebPushSubscription = z.infer<typeof WebPushSubscriptionSchema>;

// PUT /v1/push/token: one wake address per device; a new one replaces the old.
export const PushTokenRequestSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('fcm'), token: z.string().min(1).max(4_096) }),
  z.object({ provider: z.literal('webpush'), subscription: WebPushSubscriptionSchema }),
]);
export type PushTokenRequest = z.infer<typeof PushTokenRequestSchema>;

/**
 * The whole push payload (ARCHITECTURE A2): `wake` fetches the mailbox, `call` (Phase 26)
 * rings. Nothing else may be added; the content stays in the E2EE mailbox.
 */
export type PushPayload = { t: 'wake' } | { t: 'call' };
export const PUSH_WAKE: PushPayload = Object.freeze({ t: 'wake' });
