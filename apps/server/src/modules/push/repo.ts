/**
 * `push_tokens`: one wake address per device (ADR 0015). It is account metadata like the device
 * record: an FCM token, a Web Push subscription or APNs tokens (ADR 0032), never anything about
 * messages.
 */
import type { Collection, Db } from 'mongodb';

import type { PushProvider, PushTokenRequest, WebPushSubscription } from '@pingdost/shared-types';

import type { Clock } from '../../infra/clock';
import type { IndexSetup } from '../../infra/mongo';

export interface PushTokenDoc {
  /** The device ID. */
  _id: string;
  userId: string;
  provider: PushProvider;
  /** The FCM registration token, the Web Push endpoint URL, or the APNs alert token. */
  address: string;
  /** Web Push only: the subscription's encryption keys. */
  keys?: WebPushSubscription['keys'];
  /** APNs only: the PushKit VoIP token that call pushes go to. */
  voip?: string;
  /** APNs only: a development build's tokens, valid only at Apple's sandbox gateway. */
  sandbox?: boolean;
  updatedAt: Date;
}

/** Where a wake goes, as the senders see it. */
export type PushTarget = Pick<PushTokenDoc, 'provider' | 'address' | 'keys' | 'voip' | 'sandbox'>;

export const pushTokenIndexes: IndexSetup = async (db) => {
  const tokens = db.collection<PushTokenDoc>('push_tokens');
  await tokens.createIndex({ address: 1 });
  await tokens.createIndex({ voip: 1 }, { sparse: true });
};

function addressOf(request: PushTokenRequest): string {
  switch (request.provider) {
    case 'fcm':
    case 'apns':
      return request.token;
    case 'webpush':
      return request.subscription.endpoint;
  }
}

export class PushTokens {
  readonly #tokens: Collection<PushTokenDoc>;

  constructor(
    db: Db,
    private readonly clock: Clock,
  ) {
    this.#tokens = db.collection<PushTokenDoc>('push_tokens');
  }

  /**
   * Stores the device's address, replacing its previous one. An address belongs to one
   * device: a reinstalled app keeps its FCM token under a new device ID, so the old device
   * loses it (otherwise one phone would be woken for two devices). The same holds for an
   * iPhone's VoIP token.
   */
  async put(userId: string, deviceId: string, request: PushTokenRequest): Promise<void> {
    const address = addressOf(request);
    const voip = request.provider === 'apns' ? request.voipToken : undefined;
    await this.#tokens.deleteMany({
      _id: { $ne: deviceId },
      $or: [{ address }, ...(voip ? [{ voip }] : [])],
    });
    await this.#tokens.replaceOne(
      { _id: deviceId },
      {
        userId,
        provider: request.provider,
        address,
        ...(request.provider === 'webpush' ? { keys: request.subscription.keys } : {}),
        ...(voip ? { voip } : {}),
        ...(request.provider === 'apns' && request.environment === 'sandbox'
          ? { sandbox: true }
          : {}),
        updatedAt: new Date(this.clock.now()),
      },
      { upsert: true },
    );
  }

  async get(deviceId: string): Promise<PushTarget | undefined> {
    return (
      (await this.#tokens.findOne(
        { _id: deviceId },
        { projection: { _id: 0, provider: 1, address: 1, keys: 1, voip: 1, sandbox: 1 } },
      )) ?? undefined
    );
  }

  async delete(deviceId: string): Promise<void> {
    await this.#tokens.deleteOne({ _id: deviceId });
  }

  /** Drops an address the provider rejected, unless the device registered a new one since. */
  async deleteInvalid(deviceId: string, address: string): Promise<void> {
    await this.#tokens.deleteOne({ _id: deviceId, address });
  }

  /** Drops a VoIP token APNs rejected; the alert token stays. */
  async deleteInvalidVoip(deviceId: string, voip: string): Promise<void> {
    await this.#tokens.updateOne({ _id: deviceId, voip }, { $unset: { voip: '' } });
  }
}
