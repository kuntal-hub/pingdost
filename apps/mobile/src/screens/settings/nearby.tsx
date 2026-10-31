// Settings → Nearby messaging (Phase 22, ADR 0024): the toggle, what it is doing now, and a
// way out of every state that stops it (REQ §19.4: degraded states are visible).
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Linking, Switch, Text } from 'react-native';

import { ListRow, ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import {
  refreshNearby,
  setNearbyEnabled,
  startNearby,
  useNearby,
  useNearbyStatus,
} from '@/nearby/service';
import { describeNearby } from '@/nearby/status';
import { usePalette } from '@/theme/theme-root';

export function openBluetoothSettings(): void {
  void Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS').catch(() =>
    Linking.openSettings(),
  );
}

/** What nearby messaging does and what it shows to others (this screen and the setup). */
export function NearbyExplainer() {
  return (
    <>
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        How it works
      </Text>
      <Text className="text-foreground">
        When there is no internet, messages to a contact whose phone is within Bluetooth range
        (usually a few metres to a few tens of metres) go directly to that phone. Otherwise they
        wait on this phone, marked &quot;Queued on this device — waiting for a nearby route&quot;,
        and go as soon as the contact comes into range or the internet is back.
      </Text>
      <Text className="text-foreground">
        Messages stay end-to-end encrypted, exactly as over the internet. A message shows
        &quot;Delivered&quot; only when the recipient&apos;s phone confirms it.
      </Text>
      <Text className="text-foreground">
        You can message a contact offline only after this phone has been online with them once: it
        keeps their keys for that.
      </Text>
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        What others nearby can see
      </Text>
      <Text className="text-muted">
        While this is on, your phone advertises over Bluetooth with a random code that changes every
        10 minutes. Other PingDost phones nearby can tell that a PingDost phone is near. When they
        connect, they see this phone&apos;s public device key, not your name, number or username.
        Only phones of people you already chat with recognise that key, and nothing is sent to
        anyone else.
      </Text>
      <Text className="text-muted">
        Android shows a &quot;Nearby is on&quot; notification while it runs. Battery savers,
        force-stopping the app or turning Bluetooth off pause it. It works best with PingDost open.
      </Text>
    </>
  );
}

export function NearbyMessagingScreen() {
  const router = useRouter();
  const palette = usePalette();
  const enabled = useNearby((state) => state.enabled);
  const unknown = useNearby((state) => state.summary.unknown);
  const status = useNearbyStatus();
  const text = describeNearby(status);
  const available = status.kind !== 'unavailable';

  // Back from the system settings: the permission or Bluetooth may have changed.
  useFocusEffect(
    useCallback(() => {
      void refreshNearby()
        .then(() => startNearby())
        .catch(() => undefined);
    }, []),
  );

  function toggle(value: boolean): void {
    if (value) {
      // Explain the permission before Android asks for it.
      if (!enabled) router.push('/nearby-setup');
      return;
    }
    void setNearbyEnabled(false).catch(() => undefined);
  }

  return (
    <Screen>
      <ListSection>
        <ListRow
          title="Nearby messaging"
          subtitle={text.title}
          {...(available ? { onPress: () => toggle(!enabled) } : {})}
          accessory={
            <Switch
              accessibilityLabel="Nearby messaging"
              value={enabled && available}
              disabled={!available}
              onValueChange={toggle}
              trackColor={{ true: palette.primary, false: palette.border }}
            />
          }
        />
      </ListSection>

      <Text
        accessibilityLiveRegion="polite"
        className={text.tone === 'warning' ? 'font-semibold text-danger' : 'text-muted'}
      >
        {text.detail}
      </Text>

      {status.kind === 'permission' && (
        <ListSection>
          <ListRow title="Allow permission" onPress={() => router.push('/nearby-setup')} />
          <ListRow title="Open app settings" onPress={() => void Linking.openSettings()} />
        </ListSection>
      )}
      {status.kind === 'bluetooth_off' && (
        <ListSection>
          <ListRow title="Open Bluetooth settings" onPress={openBluetoothSettings} />
        </ListSection>
      )}
      {status.kind === 'on' && unknown > 0 && (
        <Text className="text-muted">
          {unknown === 1 ? 'Another PingDost phone is' : `${unknown} other PingDost phones are`} in
          range. They are not your contacts, so nothing is sent to them.
        </Text>
      )}

      <NearbyExplainer />
    </Screen>
  );
}
