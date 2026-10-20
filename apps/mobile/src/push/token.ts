// This phone's FCM token on the server (Phase 12, ADR 0015). The server only ever sends it a
// content-free wake. A build without `google-services.json` has no token: it simply gets no
// pushes and fetches messages when opened.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { api } from '@/api';

import { ensureChannels } from './notifications';

/** What this process last registered, so repeated starts do not PUT it again. */
let registered: { deviceId: string; token: string } | undefined;

async function register(deviceId: string, token: string): Promise<void> {
  if (registered?.deviceId === deviceId && registered.token === token) return;
  await api.push.registerToken({ provider: 'fcm', token });
  registered = { deviceId, token };
}

/**
 * Registers the token and keeps it current while the device is signed in; returns the stop
 * function. Best effort: failures are retried on the next start. Logout deletes the token on
 * the server (`api/index.ts`), so stopping forgets it here too.
 */
export function startPushToken(deviceId: string): () => void {
  if (Platform.OS !== 'android') return () => undefined;
  void (async () => {
    await ensureChannels();
    const token = await Notifications.getDevicePushTokenAsync();
    if (typeof token.data === 'string') await register(deviceId, token.data);
  })().catch((error: unknown) => {
    if (__DEV__) console.warn('[push] no push token (is google-services.json set up?)', error);
  });
  const subscription = Notifications.addPushTokenListener((token) => {
    if (typeof token.data !== 'string') return;
    void register(deviceId, token.data).catch(() => undefined);
  });
  return () => {
    subscription.remove();
    registered = undefined;
  };
}

export type PermissionState = 'granted' | 'ask' | 'denied';

/** Whether notifications may be shown, can be asked for, or must be enabled in settings. */
export async function notificationPermission(): Promise<PermissionState> {
  const { granted, canAskAgain } = await Notifications.getPermissionsAsync();
  if (granted) return 'granted';
  return canAskAgain ? 'ask' : 'denied';
}

/** Shows the system prompt (Android 13+); call only after explaining why. */
export async function requestNotificationPermission(): Promise<PermissionState> {
  await ensureChannels();
  const { granted, canAskAgain } = await Notifications.requestPermissionsAsync();
  if (granted) return 'granted';
  return canAskAgain ? 'ask' : 'denied';
}
