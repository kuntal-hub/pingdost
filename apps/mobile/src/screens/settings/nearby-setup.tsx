// Turning on nearby messaging (Phase 22): why PingDost needs Bluetooth and the Nearby devices
// permission (Location on Android 8–11), asked only after the user reads this.
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { Screen } from '@/components/screen';
import {
  refreshNearby,
  requestNearbyPermissions,
  setNearbyEnabled,
  useNearby,
} from '@/nearby/service';
import { needsLocation } from '@/nearby/status';

import { NearbyExplainer, openBluetoothSettings } from './nearby';

export function NearbySetupScreen() {
  const router = useRouter();
  const native = useNearby((state) => state.native);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const missing = native?.missingPermissions ?? [];
  const location = needsLocation(missing);

  useEffect(() => {
    void refreshNearby().catch(() => undefined);
  }, []);

  async function turnOn(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await requestNearbyPermissions();
      if (outcome !== 'granted') {
        setBlocked(outcome === 'blocked');
        return;
      }
      await setNearbyEnabled(true);
      router.back();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Text accessibilityRole="header" className="text-2xl font-semibold text-foreground">
        Message people nearby without internet
      </Text>
      <Text className="text-foreground">
        {location
          ? 'PingDost uses Bluetooth to find your contacts’ phones close by. On this Android version, finding Bluetooth devices needs the Location permission, with location turned on. PingDost never reads or stores your location.'
          : 'PingDost uses Bluetooth to find your contacts’ phones close by. Android calls this the “Nearby devices” permission. PingDost does not use your location.'}
      </Text>
      <NearbyExplainer />

      {native && !native.enabled && (
        <View className="gap-2 rounded-md border border-border bg-surface px-4 py-3">
          <Text className="font-semibold text-foreground">Bluetooth is off</Text>
          <Text className="text-muted">Nearby messaging starts once Bluetooth is on.</Text>
          <Button
            label="Open Bluetooth settings"
            variant="secondary"
            onPress={openBluetoothSettings}
          />
        </View>
      )}
      {blocked ? (
        <View className="gap-2">
          <Text accessibilityLiveRegion="polite" className="font-semibold text-danger">
            The permission is turned off for PingDost. Allow{' '}
            {location ? 'Location' : 'Nearby devices'} in the app settings, then come back.
          </Text>
          <Button label="Open app settings" onPress={() => void Linking.openSettings()} />
        </View>
      ) : (
        <Button
          label={missing.length > 0 ? 'Allow and turn on' : 'Turn on'}
          loading={busy}
          onPress={() => void turnOn()}
        />
      )}
      <Button label="Not now" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
