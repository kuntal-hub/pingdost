// A `{"t":"circle"}` push (Phase 37, ADR 0041): someone asked to join this user's circle, or
// accepted their request. The push says nothing more; the app fetches the lists itself and
// shows a local notification with the name from the public profile.
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { authStore } from '@/api';
import { stageOf } from '@/auth/auth-store';
import { useCircle } from '@/engine/circle';
import { circleChanges, personName } from '@/engine/circle-logic';

import { CIRCLE_CHANNEL, ensureChannels } from './notifications';

let running: Promise<void> | undefined;

/** Handles one circle push; concurrent ones share it. Never throws. */
export function handleCircleWake(): Promise<void> {
  running ??= notify()
    .catch((error: unknown) => {
      if (__DEV__) console.warn('[push] circle wake failed', error);
    })
    .finally(() => {
      running = undefined;
    });
  return running;
}

async function notify(): Promise<void> {
  await authStore.getState().hydrate();
  if (stageOf(authStore.getState()) !== 'ready') return;
  const circle = useCircle.getState();
  await circle.loadCached();
  const before = useCircle.getState();
  await circle.load();
  // On screen, the chat list's Requests row shows it.
  if (AppState.currentState === 'active') return;
  const { requests, accepted } = circleChanges(before, useCircle.getState());
  if (requests.length === 0 && accepted.length === 0) return;
  await ensureChannels();
  const trigger = Platform.OS === 'android' ? { channelId: CIRCLE_CHANNEL } : null;
  for (const request of requests) {
    await Notifications.scheduleNotificationAsync({
      identifier: `circle-request:${request.userId}`,
      content: {
        title: 'Circle request',
        body: `${personName(request)} wants to join your circle`,
        data: { circle: 'requests' },
      },
      trigger,
    });
  }
  for (const member of accepted) {
    await Notifications.scheduleNotificationAsync({
      identifier: `circle-accepted:${member.userId}`,
      content: {
        title: 'Added to your circle',
        body: `${personName(member)} accepted your request. You can message each other now.`,
        data: { circle: 'members', userId: member.userId },
      },
      trigger,
    });
  }
}
