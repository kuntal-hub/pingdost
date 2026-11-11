// The background task FCM data messages run (Phase 12). It must be defined at module scope in a
// file the entry (`index.ts`) loads before the app: when the app was swiped away, the OS starts
// the JS bundle headless, renders nothing, and runs only this task.
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { pushKind } from '@/calls/logic';
import { handleCallWake } from '@/calls/wake';

import { handleCircleWake } from './circle';
import { handleWake } from './wake';

export const PUSH_WAKE_TASK = 'pingdost-push-wake';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_WAKE_TASK, async ({ data }) => {
  // A tap on a notification is handled by the app (deep link), not here.
  if (!data || 'actionIdentifier' in data) {
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }
  // Our server sends only `{"t":"wake"}` (fetch the mailbox), `{"t":"call"}` (an E2EE call
  // invite is waiting, ADR 0029) or `{"t":"circle"}` (a circle request or accept, Phase 37);
  // none carries anything else.
  const kind = pushKind(data);
  if (kind === 'call') await handleCallWake();
  else if (kind === 'circle') await handleCircleWake();
  else await handleWake();
  return Notifications.BackgroundNotificationTaskResult.NewData;
});

void Notifications.registerTaskAsync(PUSH_WAKE_TASK).catch((error: unknown) => {
  if (__DEV__) console.warn('[push] task registration failed', error);
});
