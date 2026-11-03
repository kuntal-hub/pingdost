import type { ServerConfig } from '@pingdost/config';
import type { PushProvider } from '@pingdost/shared-types';

import { ApnsSender } from './apns';
import { FcmSender } from './fcm';
import type { PushSender } from './notifier';
import { WebPushSender } from './webpush';
import type { Clock } from '../../infra/clock';

/** FCM and Web Push keep a message at most 4 weeks (APNs keeps only the last one anyway). */
const PROVIDER_MAX_TTL_SECONDS = 28 * 86_400;

/**
 * The senders for the configured providers. A wake older than the mailbox retention finds
 * nothing to fetch, so that bounds how long providers keep one.
 */
export function createPushSenders(
  config: ServerConfig,
  clock: Clock,
): Partial<Record<PushProvider, PushSender>> {
  const ttlSeconds = Math.min(config.MESSAGE_MAX_RETENTION_SECONDS, PROVIDER_MAX_TTL_SECONDS);
  return {
    ...(config.fcm ? { fcm: new FcmSender({ ...config.fcm, ttlSeconds, clock }) } : {}),
    ...(config.webPush ? { webpush: new WebPushSender({ ...config.webPush, ttlSeconds }) } : {}),
    ...(config.apns
      ? {
          apns: new ApnsSender({
            keyId: config.apns.keyId,
            teamId: config.apns.teamId,
            privateKeyPem: Buffer.from(config.apns.privateKeyBase64, 'base64').toString('utf8'),
            bundleId: config.apns.bundleId,
            ttlSeconds,
            clock,
          }),
        }
      : {}),
  };
}
