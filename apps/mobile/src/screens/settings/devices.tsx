import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert } from 'react-native';

import { api } from '@/api';
import { describeError } from '@/api/errors';
import { useAuth } from '@/auth/use-auth';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { useChatRuntime } from '@/engine/hooks';
import { useCryptoContext } from '@/hooks/use-crypto-context';
import { describeSync, useSyncSendProgress } from '@/sync/progress';
import { usePalette } from '@/theme/theme-root';
import type { DeviceSummary } from '@pingdost/shared-types';

const day = (ms: number) => new Date(ms).toLocaleDateString();

function describeDevice(device: DeviceSummary, current: boolean): string {
  const kind = device.platform === 'web' ? 'Browser' : 'Phone';
  const parts = [current ? 'This phone' : kind, `added ${day(device.createdAt)}`];
  if (device.status === 'revoked' && device.revokedAt)
    parts.push(`removed ${day(device.revokedAt)}`);
  else if (device.lastSeenAt && !current) parts.push(`last active ${day(device.lastSeenAt)}`);
  return parts.join(' · ');
}

export function DevicesScreen() {
  const router = useRouter();
  const runtime = useChatRuntime();
  const palette = usePalette();
  const currentId = useAuth((state) => state.session?.deviceId);
  const crypto = useCryptoContext();
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const syncs = useSyncSendProgress();

  const load = useCallback(() => {
    setError(null);
    api.devices
      .list()
      .then(setDevices, (caught: unknown) => setError(describeError(caught).message));
  }, []);

  // Reloaded on return, e.g. after linking a browser.
  useFocusEffect(load);

  function confirmRevoke(device: DeviceSummary): void {
    Alert.alert(
      `Remove ${device.name}?`,
      'It is signed out at once and can no longer read new messages.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () =>
            void api.devices.revoke(device.deviceId).then(
              () => {
                load();
                // Stop encrypting to it now, not when the directory cache runs out.
                if (runtime)
                  void runtime.engine.refreshDevices(runtime.userId).catch(() => undefined);
              },
              (caught: unknown) => setError(describeError(caught).message),
            ),
        },
      ],
    );
  }

  const active = devices?.filter((device) => device.status === 'active') ?? [];
  const removed = devices?.filter((device) => device.status === 'revoked') ?? [];
  const linked = active.filter((device) => device.role === 'linked');
  const primary = active.some(
    (device) => device.deviceId === currentId && device.role === 'primary',
  );

  return (
    <Screen offlineBanner>
      {error && (
        <>
          <Notice tone="error" message={error} />
          <Button label="Try again" variant="secondary" onPress={load} />
        </>
      )}
      {!devices && !error && <ActivityIndicator color={palette.accent} />}

      {devices && (
        <ListSection title="Active">
          {active.map((device) => (
            <ListRow
              key={device.deviceId}
              title={device.name}
              subtitle={[
                describeDevice(device, device.deviceId === currentId),
                describeSync(syncs[device.deviceId]),
              ]
                .filter(Boolean)
                .join('\n')}
              {...(device.role === 'linked' ? { onPress: () => confirmRevoke(device) } : {})}
            />
          ))}
        </ListSection>
      )}
      {devices && primary && (
        <ListSection title="Browsers">
          <ListRow
            title="Link a browser"
            subtitle="Scan the code PingDost on the web shows"
            onPress={() => router.push('/link-browser')}
          />
        </ListSection>
      )}
      {devices && linked.length === 0 && (
        <Text className="text-muted">
          No linked browsers. A linked browser gets its own keys and can be removed here at any
          time; tap a browser above to remove it.
        </Text>
      )}
      {removed.length > 0 && (
        <ListSection title="Removed">
          {removed.map((device) => (
            <ListRow
              key={device.deviceId}
              title={device.name}
              subtitle={describeDevice(device, false)}
            />
          ))}
        </ListSection>
      )}

      {crypto.status === 'ready' && (
        <ListSection title="This phone's encryption">
          <ListRow
            title="Identity key"
            subtitle={crypto.context.store.account.identityKeys().curve25519}
          />
          <ListRow
            title="Local database"
            subtitle={`Encrypted (SQLCipher ${crypto.context.database.cipherVersion})`}
          />
          <ListRow title="Crypto ready in" subtitle={`${crypto.context.timings.totalMs} ms`} />
        </ListSection>
      )}
    </Screen>
  );
}
