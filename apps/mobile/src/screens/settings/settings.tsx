import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, Image, Text, View } from 'react-native';

import { authStore } from '@/api';
import { useAuth } from '@/auth/use-auth';
import { ListRow, ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { useAccount } from '@/settings/account';

export function SettingsScreen() {
  const router = useRouter();
  const username = useAuth((state) => state.session?.user.username);
  const me = useAccount((state) => state.me);

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
        {
          text: 'Log out',
          style: 'destructive',
          onPress: () => void authStore.getState().logout(),
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
      </ListSection>

      <ListSection title="About">
        <ListRow title="About privacy" onPress={() => router.push('/about-privacy')} />
      </ListSection>

      {__DEV__ && (
        <ListSection title="Developer">
          <ListRow title="Crypto interop (dev)" onPress={() => router.push('/crypto')} />
        </ListSection>
      )}

      <ListSection>
        <ListRow title="Log out" destructive onPress={confirmLogout} />
      </ListSection>
    </Screen>
  );
}
