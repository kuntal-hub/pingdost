// Settings → Nearby messaging (Phase 22, ADR 0024): the toggle, what it is doing now, and a
// way out of every state that stops it (REQ §19.4: degraded states are visible).
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Linking, Platform } from 'react-native';

import { Toggle } from '@/components/controls';
import { CheckIcon, Icon } from '@/components/icon';
import { ListRow, ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import {
  refreshNearby,
  setMeshFileLimit,
  setNearbyEnabled,
  startNearby,
  useNearby,
  useNearbyStatus,
} from '@/nearby/service';
import { describeNearby, NEARBY_COPY, type NearbyPlatform } from '@/nearby/status';
import { meshTimeEstimate } from '@pingdost/attachments';

/** Which platform's wording applies (ADR 0033). */
export const nearbyPlatform: NearbyPlatform = Platform.OS === 'ios' ? 'ios' : 'android';

export function openBluetoothSettings(): void {
  // iOS has no public link to its Bluetooth settings: the app's own page has the switch.
  if (Platform.OS !== 'android') {
    void Linking.openSettings();
    return;
  }
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
      <Text className="text-muted">{NEARBY_COPY[nearbyPlatform].background}</Text>
    </>
  );
}

export function NearbyMessagingScreen() {
  const router = useRouter();
  const enabled = useNearby((state) => state.enabled);
  const unknown = useNearby((state) => state.summary.unknown);
  const fileMaxMb = useNearby((state) => state.fileMaxMb);
  const status = useNearbyStatus();
  const text = describeNearby(status, nearbyPlatform);
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
      // Explain the permission before the system asks for it.
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
            <Toggle
              accessibilityLabel="Nearby messaging"
              value={enabled && available}
              disabled={!available}
              onValueChange={toggle}
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

      {enabled && (
        <ListSection title="Largest file to send without internet">
          {FILE_LIMITS.map((mb) => (
            <ListRow
              key={mb}
              title={`${mb} MB`}
              subtitle={`${meshTimeEstimate(mb * 1_048_576)} per phone it passes`}
              onPress={() => void setMeshFileLimit(mb).catch(() => undefined)}
              accessory={fileMaxMb === mb ? <Icon icon={CheckIcon} color="accent" /> : undefined}
            />
          ))}
        </ListSection>
      )}
      {enabled && (
        <Text className="text-muted">
          Without internet, a photo, video or file goes over Bluetooth in pieces, directly or
          through phones that relay. It shows &quot;Delivered&quot; only after the recipient&apos;s
          phone has every piece and has checked the whole file. Larger files wait for the internet.
        </Text>
      )}

      <NearbyExplainer />
    </Screen>
  );
}

const FILE_LIMITS = [10, 25, 50, 100] as const;
