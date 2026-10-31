import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, Image, Text, View } from 'react-native';

import { authStore } from '@/api';
import { useAuth } from '@/auth/use-auth';
import { ListRow, ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { useNearbyStatus } from '@/nearby/service';
import { describeNearby } from '@/nearby/status';
import { removeDataFromThisPhone } from '@/recovery/remove-data';
import { useAccount } from '@/settings/account';

export function SettingsScreen() {
  const router = useRouter();
  const username = useAuth((state) => state.session?.user.username);
  const me = useAccount((state) => state.me);
  const nearby = describeNearby(useNearbyStatus());

  useEffect(() => {
    void useAccount
      .getState()
      .load()
      .catch(() => undefined);
  }, []);

  function confirmLogout(): void {
    Alert.alert(
      'Log out?',
      'Your encryption keys stay on this phone, so logging back in brings it back as the same device.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove data…', style: 'destructive', onPress: confirmRemoveData },
        {
          text: 'Log out',
          style: 'destructive',
          onPress: () => void authStore.getState().logout(),
        },
      ],
    );
  }

  function confirmRemoveData(): void {
    Alert.alert(
      'Remove data from this phone?',
      'This phone is signed out of your account for good, and its chats, files and keys are ' +
        'deleted. Without a backup, this history is gone. To use your account on another ' +
        "phone you will then need a backup (or start fresh). This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove data',
          style: 'destructive',
          onPress: () =>
            void removeDataFromThisPhone().catch(() =>
              Alert.alert(
                'Not removed',
                'PingDost could not reach the server, so nothing was deleted. Connect to the internet and try again.',
              ),
            ),
        },
      ],
    );
  }

  return (
    <Screen>
      <View className="flex-row items-center gap-4">
        {me?.avatarUrl ? (
          <Image
            source={{ uri: me.avatarUrl }}
            accessibilityIgnoresInvertColors
            accessibilityLabel="Your profile picture"
            className="h-[64px] w-[64px] rounded-full"
          />
        ) : (
          <View className="h-[64px] w-[64px] items-center justify-center rounded-full bg-primary">
            <Text importantForAccessibility="no" className="text-2xl font-bold text-on-primary">
              {(me?.displayName ?? username ?? '?').charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View className="flex-1 gap-1">
          <Text className="text-xl font-semibold text-foreground">
            {me?.displayName ?? username ?? 'PingDost'}
          </Text>
          {username && <Text className="text-muted">@{username}</Text>}
        </View>
      </View>

      <ListSection title="Account">
        <ListRow
          title="Profile"
          subtitle="Name and picture"
          onPress={() => router.push('/profile')}
        />
        <ListRow
          title="Privacy"
          subtitle="Read receipts, typing, last seen"
          onPress={() => router.push('/privacy')}
        />
        <ListRow
          title="Notifications"
          subtitle="Previews, sender name, battery"
          onPress={() => router.push('/notifications')}
        />
        <ListRow
          title="Devices"
          subtitle="This phone and linked browsers"
          onPress={() => router.push('/devices')}
        />
        <ListRow
          title="Storage"
          subtitle="Space used, automatic downloads, clear cache"
          onPress={() => router.push('/storage')}
        />
        <ListRow
          title="Backup"
          subtitle="An encrypted copy you keep, to move to a new phone"
          onPress={() => router.push('/backup')}
        />
      </ListSection>

      <ListSection title="Without internet">
        <ListRow
          title="Nearby messaging"
          subtitle={nearby.title}
          onPress={() => router.push('/nearby-messaging')}
        />
      </ListSection>

      <ListSection title="About">
        <ListRow title="About privacy" onPress={() => router.push('/about-privacy')} />
      </ListSection>

      {__DEV__ && (
        <ListSection title="Developer">
          <ListRow title="Crypto interop (dev)" onPress={() => router.push('/crypto')} />
          <ListRow
            title="Nearby spike (dev)"
            subtitle="Turn Nearby messaging off first: both read the same radio"
            onPress={() => router.push('/nearby')}
          />
        </ListSection>
      )}

      <ListSection>
        <ListRow title="Log out" destructive onPress={confirmLogout} />
      </ListSection>
    </Screen>
  );
}
