// This phone's push tokens on the server. The server only ever sends content-free pushes.
// - Android (Phase 12, ADR 0015): the FCM token. A build without `google-services.json` has no
//   token: it simply gets no pushes and fetches messages when opened.
// - iOS (Phase 29, ADR 0032): the APNs alert token, the PushKit VoIP token for calls (from the
//   `PingdostCalls` module) and the build's `aps-environment`, which decides Apple's gateway.
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { api } from '@/api';
import type { PushTokenRequest } from '@pingdost/shared-types';

import { apnsEnvironment } from './content';
import { ensureChannels } from './notifications';
import { callKitNative } from '../../modules/pingdost-calls/src';

/** What this process last registered, so repeated starts do not PUT it again. */
let registered: { deviceId: string; key: string } | undefined;

async function register(deviceId: string, request: PushTokenRequest): Promise<void> {
  const key = JSON.stringify(request);
  if (registered?.deviceId === deviceId && registered.key === key) return;
  await api.push.registerToken(request);
  registered = { deviceId, key };
}

/**
 * Registers the token and keeps it current while the device is signed in; returns the stop
 * function. Best effort: failures are retried on the next start. Logout deletes the token on
 * the server (`api/index.ts`), so stopping forgets it here too.
 */
export function startPushToken(deviceId: string): () => void {
  if (Platform.OS === 'ios') return startApnsTokens(deviceId);
  if (Platform.OS !== 'android') return () => undefined;
  const fcm = (token: string): PushTokenRequest => ({ provider: 'fcm', token });
  void (async () => {
    await ensureChannels();
    const token = await Notifications.getDevicePushTokenAsync();
    if (typeof token.data === 'string') await register(deviceId, fcm(token.data));
  })().catch((error: unknown) => {
    if (__DEV__) console.warn('[push] no push token (is google-services.json set up?)', error);
  });
  const subscription = Notifications.addPushTokenListener((token) => {
    if (typeof token.data !== 'string') return;
    void register(deviceId, fcm(token.data)).catch(() => undefined);
  });
  return () => {
    subscription.remove();
    registered = undefined;
  };
}

function startApnsTokens(deviceId: string): () => void {
  const calls = callKitNative();
  const environment = apnsEnvironment(Constants.expoConfig?.extra);
  let alert: string | undefined;
  let voip = calls?.voipToken() ?? undefined;
  const send = () => {
    if (!alert) return;
    void register(deviceId, {
      provider: 'apns',
      token: alert,
      ...(voip ? { voipToken: voip } : {}),
      environment,
    }).catch(() => undefined);
  };
  // Registering for remote notifications needs no permission; showing them does.
  void Notifications.getDevicePushTokenAsync()
    .then((token) => {
      if (typeof token.data !== 'string') return;
      alert = token.data;
      send();
    })
    .catch((error: unknown) => {
      if (__DEV__) console.warn('[push] no APNs token (signing without push?)', error);
    });
  const subscriptions = [
    Notifications.addPushTokenListener((token) => {
      if (typeof token.data !== 'string') return;
      alert = token.data;
      send();
    }),
    ...(calls
      ? [
          calls.addListener('voipToken', ({ token }) => {
            voip = token ?? undefined;
            send();
          }),
        ]
      : []),
  ];
  return () => {
    for (const subscription of subscriptions) subscription.remove();
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

/** Shows the system prompt (Android 13+, iOS); call only after explaining why. */
export async function requestNotificationPermission(): Promise<PermissionState> {
  await ensureChannels();
  const { granted, canAskAgain } = await Notifications.requestPermissionsAsync();
  if (granted) return 'granted';
  return canAskAgain ? 'ask' : 'denied';
}
