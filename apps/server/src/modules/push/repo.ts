/**
 * `push_tokens`: one wake address per device (ADR 0015). It is account metadata like the device
 * record: an FCM token or a Web Push subscription, never anything about messages.
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
  /** The FCM registration token, or the Web Push endpoint URL. */
  address: string;
  /** Web Push only: the subscription's encryption keys. */
  keys?: WebPushSubscription['keys'];
  updatedAt: Date;
}

/** Where a wake goes, as the senders see it. */
export type PushTarget = Pick<PushTokenDoc, 'provider' | 'address' | 'keys'>;

export const pushTokenIndexes: IndexSetup = async (db) => {
  await db.collection<PushTokenDoc>('push_tokens').createIndex({ address: 1 });
};

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
   * loses it (otherwise one phone would be woken for two devices).
   */
  async put(userId: string, deviceId: string, request: PushTokenRequest): Promise<void> {
    const address = request.provider === 'fcm' ? request.token : request.subscription.endpoint;
    await this.#tokens.deleteMany({ address, _id: { $ne: deviceId } });
    await this.#tokens.replaceOne(
      { _id: deviceId },
      {
        userId,
        provider: request.provider,
        address,
        ...(request.provider === 'webpush' ? { keys: request.subscription.keys } : {}),
        updatedAt: new Date(this.clock.now()),
      },
      { upsert: true },
    );
  }

  async get(deviceId: string): Promise<PushTarget | undefined> {
    return (
      (await this.#tokens.findOne(
        { _id: deviceId },
        { projection: { _id: 0, provider: 1, address: 1, keys: 1 } },
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
}
