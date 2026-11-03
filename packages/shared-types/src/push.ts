/**
 * Push wake registration: `PUT|DELETE /v1/push/token` (Phase 12, ADR 0015). A push only wakes
 * a device so it connects and fetches its mailbox: payloads never carry message data.
 */
import { z } from 'zod';

export const PushProviderSchema = z.enum(['fcm', 'webpush', 'apns']);
export type PushProvider = z.infer<typeof PushProviderSchema>;

/** An APNs device token: hex (32 bytes today; Apple says not to rely on the length). */
const ApnsTokenSchema = z
  .string()
  .regex(/^[0-9a-fA-F]+$/, 'must be hex')
  .min(64)
  .max(512);

/**
 * APNs (ADR 0032): the alert token, the PushKit VoIP token for calls (absent in a build
 * without the calls module), and the app's `aps-environment`: development builds get sandbox
 * tokens, which only Apple's sandbox gateway accepts.
 */
export const ApnsTokenRequestSchema = z.object({
  provider: z.literal('apns'),
  token: ApnsTokenSchema,
  voipToken: ApnsTokenSchema.optional(),
  environment: z.enum(['sandbox', 'production']),
});
export type ApnsTokenRequest = z.infer<typeof ApnsTokenRequestSchema>;

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
  ApnsTokenRequestSchema,
]);
export type PushTokenRequest = z.infer<typeof PushTokenRequestSchema>;

/**
 * The whole push payload (ARCHITECTURE A2): `wake` fetches the mailbox; `call` (ADR 0028) says
 * an E2EE call invite is waiting, so the device connects at once and shows the incoming call
 * when the invite arrives. No caller, no SDP. Nothing else may be added. (On iOS the APNs
 * request adds a constant `aps` dictionary around it so iOS shows "New message"; ADR 0032.)
 */
export type PushPayload = { t: 'wake' } | { t: 'call' };
export const PUSH_WAKE: PushPayload = Object.freeze({ t: 'wake' });
export const PUSH_CALL: PushPayload = Object.freeze({ t: 'call' });
