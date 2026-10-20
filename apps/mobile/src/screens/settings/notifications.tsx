import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Switch, Text } from 'react-native';

import { ListRow, ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import type { NotificationPrefs } from '@/push/content';
import { useNotificationPrefs } from '@/push/prefs';
import {
  notificationPermission,
  requestNotificationPermission,
  type PermissionState,
} from '@/push/token';
import { usePalette } from '@/theme/theme-root';

const toggles: { key: keyof NotificationPrefs; title: string; subtitle: string }[] = [
  {
    key: 'showPreviews',
    title: 'Show message previews',
    subtitle: 'Show the text of new messages. When off, notifications say "New message".',
  },
  {
    key: 'hideSender',
    title: 'Hide sender name',
    subtitle: 'Show "PingDost" instead of who wrote.',
  },
];

function openBatterySettings(): void {
  void Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() =>
    Linking.openSettings(),
  );
}

export function NotificationsScreen() {
  const palette = usePalette();
  const prefs = useNotificationPrefs((state) => state.prefs);
  const [permission, setPermission] = useState<PermissionState | null>(null);

  useEffect(() => {
    void useNotificationPrefs
      .getState()
      .load()
      .catch(() => undefined);
  }, []);

  // Coming back from the system settings may have changed the permission.
  useFocusEffect(
    useCallback(() => {
      void notificationPermission()
        .then(setPermission)
        .catch(() => undefined);
    }, []),
  );

  function toggle(key: keyof NotificationPrefs, value: boolean): void {
    void useNotificationPrefs
      .getState()
      .update({ [key]: value })
      .catch(() => undefined);
  }

  function allow(): void {
    if (permission === 'ask') {
      void requestNotificationPermission()
        .then(setPermission)
        .catch(() => undefined);
    } else {
      void Linking.openSettings();
    }
  }

  return (
    <Screen>
      {permission !== null && permission !== 'granted' && (
        <ListSection>
          <ListRow
            title="Notifications are off"
            subtitle={
              permission === 'ask'
                ? 'Allow them to know when messages arrive.'
                : 'Turn them on in the system settings for PingDost.'
            }
            onPress={allow}
          />
        </ListSection>
      )}

      <ListSection title="Messages">
        {toggles.map((option) => (
          <ListRow
            key={option.key}
            title={option.title}
            subtitle={option.subtitle}
            onPress={() => toggle(option.key, !prefs[option.key])}
            accessory={
              <Switch
                accessibilityLabel={option.title}
                value={prefs[option.key]}
                onValueChange={(value) => toggle(option.key, value)}
                trackColor={{ true: palette.primary, false: palette.border }}
              />
            }
          />
        ))}
      </ListSection>

      {Platform.OS === 'android' && (
        <ListSection title="If notifications arrive late">
          <ListRow
            title="Battery optimization"
            subtitle='Android delays wake-ups for apps it puts to sleep. Choose "Unrestricted" (or "Not optimized") for PingDost.'
            onPress={openBatterySettings}
          />
          <ListRow
            title="System notification settings"
            onPress={() => void Linking.openSettings()}
          />
        </ListSection>
      )}

      <Text className="text-muted">
        These settings apply to this phone only. Muted chats never notify (long-press a chat to mute
        it).
      </Text>
      <Text className="text-muted">
        Our server never puts message content in a push. It only sends an empty wake-up signal; your
        phone then fetches the encrypted message and decrypts it on the device. Notifications you
        have seen stay in the notification shade until you clear them, and a message deleted for
        everyone cannot remove a notification that was already shown.
      </Text>
    </Screen>
  );
}
