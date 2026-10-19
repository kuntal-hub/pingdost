// Wires device setup to the phone: the crypto context (SQLCipher + Olm account),
// SecureStore, and the API. Setup tasks mutate the Olm account, so they run one at a time.
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { z } from 'zod';

import { api, authStore } from '@/api';
import { getCryptoContext, type CryptoContext } from '@/crypto/bootstrap';
import { SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { readSetting, SETTING_KEYS, writeSetting } from '@/db/settings';
import { wipeChatData } from '@/engine/sqlite-store';
import { DeviceNameSchema, IdSchema } from '@pingdost/shared-types';

import { syncKeys, type PublishKeysResult } from './keys';
import { setUpDevice, type DeviceSetupResult, type LocalDevice } from './setup';

const LocalDeviceSchema = z.object({ deviceId: IdSchema, userId: IdSchema });

let queue: Promise<unknown> = Promise.resolve();

/** Runs `task` after every earlier device task has settled. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** e.g. "vivo V2437"; the server shows it in the device list. */
export function deviceName(): string {
  const constants = Platform.constants as { Brand?: string; Model?: string };
  const name = [constants.Brand, constants.Model].filter(Boolean).join(' ').trim();
  const parsed = DeviceNameSchema.safeParse(name.slice(0, 64));
  return parsed.success ? parsed.data : Platform.OS === 'ios' ? 'iPhone' : 'Android phone';
}

export function loadLocalDevice(context: CryptoContext): Promise<LocalDevice | null> {
  return readSetting(context.database.db, SETTING_KEYS.device, LocalDeviceSchema);
}

function syncOwnKeys(
  context: CryptoContext,
  userId: string,
  deviceId: string,
): Promise<PublishKeysResult> {
  return syncKeys({
    userId,
    deviceId,
    account: context.store.account,
    saveAccount: () => context.store.saveAccount(),
    directory: (id) => api.keys.directory(id),
    keys: api.keys,
  });
}

/** Registers (or resumes) this phone as the signed-in account's primary device. */
export function setUpThisDevice(): Promise<DeviceSetupResult> {
  return serialized(async () => {
    const session = authStore.getState().session;
    if (!session) throw new Error('not signed in');
    const context = await getCryptoContext();
    // An earlier run already bound this session; registering again would be a CONFLICT.
    if (session.deviceId) {
      const keys = await syncOwnKeys(context, session.user.userId, session.deviceId);
      return { deviceId: session.deviceId, keys };
    }
    const { db } = context.database;
    return setUpDevice({
      userId: session.user.userId,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      deviceName: deviceName(),
      provider: context.provider,
      crypto: {
        account: () => context.store.account,
        saveAccount: () => context.store.saveAccount(),
        // A revoked identity's sessions and chats go with it (ADR 0012).
        resetAccount: async () => {
          await wipeChatData(db);
          await context.store.resetAccount();
        },
      },
      localDevice: {
        load: () => loadLocalDevice(context),
        save: (device) => writeSetting(db, SETTING_KEYS.device, device),
      },
      identityKey: {
        load: () => SecureStore.getItemAsync(SECRET_ITEMS.accountIdentityKey, SECURE_STORE_OPTIONS),
        save: (secret) =>
          SecureStore.setItemAsync(SECRET_ITEMS.accountIdentityKey, secret, SECURE_STORE_OPTIONS),
      },
      api: {
        me: () => api.account.me(),
        challenge: () => api.devices.challenge(),
        register: (body) => api.devices.register(body),
        directory: (userId) => api.keys.directory(userId),
        keys: api.keys,
      },
      bindDevice: (deviceId, tokens) => authStore.getState().bindDevice(deviceId, tokens),
    });
  });
}

// Once the device is set up, the chat engine tops up keys (`engine.replenishKeys`, at start
// and on the gateway's OtkLow): it serializes account changes with decryption (ADR 0012).
