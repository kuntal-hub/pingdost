// Local notifications for received messages (Phase 12, ADR 0015). Pushes from the server are
// content-free wakes; the text shown here was decrypted on this phone and never leaves it.
// - one notification per chat (its ID is the conversation ID), replaced by newer messages;
// - none while the app is on screen, for muted chats, or for this user's own messages;
// - opening the chat removes it.
// On iOS (ADR 0032) APNs also shows the server's constant "New message" alert, because iOS does
// not wake a force-quit app for a silent push. It is not shown while the app is open, and it is
// removed once the app has fetched (on opening, or after a background wake), so the app's own
// notification takes its place and mute applies.
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { contactName, loadContact } from '@/engine/contacts';
import type { MessageEngine, MessageRecord } from '@pingdost/message-engine';

import { isServerNotice, notificationContent, shouldNotify } from './content';
import { useNotificationPrefs } from './prefs';

export const MESSAGES_CHANNEL = 'messages';
/** Missed calls (ADR 0029). Ringing uses the native `incoming_calls` channel (modules/pingdost-calls). */
export const MISSED_CALLS_CHANNEL = 'missed_calls';
/** Phase 12's placeholder for calls, replaced by the native channels: removed. */
const OLD_CALLS_CHANNEL = 'calls';

Notifications.setNotificationHandler({
  handleNotification: (notification) => {
    // The app is open and connected: the server's constant alert would only repeat it.
    const show = !isServerNotice(notification);
    return Promise.resolve({
      shouldShowBanner: show,
      shouldShowList: show,
      shouldPlaySound: show,
      shouldSetBadge: false,
    });
  },
});

/** iOS: removes the server's constant alerts (the app has fetched what they announced). */
export async function clearServerNotices(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const shown = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    shown
      .filter(isServerNotice)
      .map((notification) =>
        Notifications.dismissNotificationAsync(notification.request.identifier),
      ),
  );
}

let channels: Promise<void> | undefined;

/** Android needs the channels before it can ask for permission or hand out a token. */
export function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  channels ??= (async () => {
    await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
      name: 'Messages',
      description: 'New messages in your chats',
      importance: Notifications.AndroidImportance.HIGH,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
    await Notifications.setNotificationChannelAsync(MISSED_CALLS_CHANNEL, {
      name: 'Missed calls',
      description: 'Calls you did not answer',
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
    await Notifications.deleteNotificationChannelAsync(OLD_CALLS_CHANNEL).catch(() => undefined);
  })().catch((error: unknown) => {
    channels = undefined;
    throw error;
  });
  return channels;
}

async function present(engine: MessageEngine, message: MessageRecord): Promise<void> {
  const conversation = await engine.getConversation(message.conversationId);
  const appActive = AppState.currentState === 'active';
  if (!shouldNotify({ message, conversation, appActive, now: Date.now() })) return;
  const prefs = await useNotificationPrefs.getState().load();
  const contact = prefs.hideSender ? undefined : await loadContact(message.senderUserId);
  const group =
    conversation?.kind === 'group' ? await engine.getGroup(conversation.conversationId) : undefined;
  const { title, body } = notificationContent({
    senderName: contactName(contact),
    ...(group ? { groupName: group.name || 'Group' } : {}),
    message,
    unreadCount: conversation?.unreadCount ?? 1,
    prefs,
  });
  await ensureChannels();
  await Notifications.scheduleNotificationAsync({
    identifier: message.conversationId,
    content: { title, body, data: { conversationId: message.conversationId } },
    trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
  });
}

/** Shows a notification for each message the engine receives; returns the unsubscribe. */
export function installNotifier(engine: MessageEngine): () => void {
  const unsubscribe = engine.onEvent((event) => {
    if (event.type !== 'received') return;
    void present(engine, event.message).catch((error: unknown) => {
      if (__DEV__) console.warn('[push] notification failed', error);
    });
  });
  if (Platform.OS !== 'ios') return unsubscribe;
  const clear = () => void clearServerNotices().catch(() => undefined);
  if (AppState.currentState === 'active') clear();
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') clear();
  });
  return () => {
    unsubscribe();
    appState.remove();
  };
}

/** Removes a chat's notification (the chat was opened). */
export function dismissChatNotification(conversationId: string): void {
  void Notifications.dismissNotificationAsync(conversationId).catch(() => undefined);
}

/** The conversation a tapped notification belongs to, if it is one of ours. */
export function conversationOf(
  response: Notifications.NotificationResponse | null | undefined,
): string | undefined {
  if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
    return undefined;
  }
  const id = response.notification.request.content.data?.conversationId;
  return typeof id === 'string' ? id : undefined;
}
