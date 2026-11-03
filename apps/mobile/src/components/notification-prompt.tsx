import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { useNotificationPrefs } from '@/push/prefs';
import {
  notificationPermission,
  requestNotificationPermission,
  type PermissionState,
} from '@/push/token';

/** What the card says per platform: Android wakes the app silently, iOS shows a fixed alert. */
const EXPLAINER =
  Platform.OS === 'ios'
    ? 'While PingDost is closed, our server asks Apple to show “New message” on your phone, with nothing else in it. Your phone then fetches the encrypted message and decrypts it itself: neither Apple nor our server can read it.'
    : 'While PingDost is closed, our server sends your phone an empty wake-up signal. Your phone then fetches the encrypted message and decrypts it itself, so the notification text never passes through Google or our server.';

/**
 * Explains notifications before the system permission prompt (Android 13+ and iOS, which can
 * ask only once or a couple of times). Hidden once answered or dismissed.
 */
export function NotificationPrompt() {
  const loaded = useNotificationPrefs((state) => state.loaded);
  const dismissed = useNotificationPrefs((state) => state.prefs.promptDismissed);
  const [permission, setPermission] = useState<PermissionState | null>(null);

  useEffect(() => {
    void useNotificationPrefs
      .getState()
      .load()
      .catch(() => undefined);
    void notificationPermission()
      .then(setPermission)
      .catch(() => undefined);
  }, []);

  if (Platform.OS === 'web' || !loaded || dismissed || permission !== 'ask') return null;
  return (
    <View className="gap-3 rounded-md border border-border bg-surface px-4 py-3">
      <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
        Know when messages arrive
      </Text>
      <Text className="text-muted">{EXPLAINER}</Text>
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            label="Turn on"
            onPress={() =>
              void requestNotificationPermission()
                .then(setPermission)
                .catch(() => undefined)
            }
          />
        </View>
        <View className="flex-1">
          <Button
            label="Not now"
            variant="secondary"
            onPress={() =>
              void useNotificationPrefs
                .getState()
                .update({ promptDismissed: true })
                .catch(() => undefined)
            }
          />
        </View>
      </View>
    </View>
  );
}
