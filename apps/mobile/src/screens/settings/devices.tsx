import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Text } from 'react-native';

import { api } from '@/api';
import { describeError } from '@/api/errors';
import { useAuth } from '@/auth/use-auth';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { useCryptoContext } from '@/hooks/use-crypto-context';
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
  const palette = usePalette();
  const currentId = useAuth((state) => state.session?.deviceId);
  const crypto = useCryptoContext();
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.devices
      .list()
      .then(setDevices, (caught: unknown) => setError(describeError(caught).message));
  }, []);

  useEffect(load, [load]);

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
            void api.devices
              .revoke(device.deviceId)
              .then(load, (caught: unknown) => setError(describeError(caught).message)),
        },
      ],
    );
  }

  const active = devices?.filter((device) => device.status === 'active') ?? [];
  const removed = devices?.filter((device) => device.status === 'revoked') ?? [];
  const linked = active.filter((device) => device.role === 'linked');

  return (
    <Screen offlineBanner>
      {error && (
        <>
          <Notice tone="error" message={error} />
          <Button label="Try again" variant="secondary" onPress={load} />
        </>
      )}
      {!devices && !error && <ActivityIndicator color={palette.primary} />}

      {devices && (
        <ListSection title="Active">
          {active.map((device) => (
            <ListRow
              key={device.deviceId}
              title={device.name}
              subtitle={describeDevice(device, device.deviceId === currentId)}
              {...(device.role === 'linked' ? { onPress: () => confirmRevoke(device) } : {})}
            />
          ))}
        </ListSection>
      )}
      {devices && linked.length === 0 && (
        <Text className="text-muted">
          No linked browsers. Linking PingDost on the web arrives in a later update.
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
