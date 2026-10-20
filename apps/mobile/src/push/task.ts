// The background task FCM data messages run (Phase 12). It must be defined at module scope in a
// file the entry (`index.ts`) loads before the app: when the app was swiped away, the OS starts
// the JS bundle headless, renders nothing, and runs only this task.
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { handleWake } from './wake';

export const PUSH_WAKE_TASK = 'pingdost-push-wake';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_WAKE_TASK, async ({ data }) => {
  // A tap on a notification is handled by the app (deep link), not here.
  if (!data || 'actionIdentifier' in data) {
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }
  // Every data message from our server is a wake; it carries nothing else to read.
  await handleWake();
  return Notifications.BackgroundNotificationTaskResult.NewData;
});

void Notifications.registerTaskAsync(PUSH_WAKE_TASK).catch((error: unknown) => {
  if (__DEV__) console.warn('[push] task registration failed', error);
});
