import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, View } from 'react-native';

import { authStore } from '@/api';
import { useAuth } from '@/auth/use-auth';
import { Avatar } from '@/components/avatar';
import { Gradient } from '@/components/gradient';
import {
  BellIcon,
  BluetoothIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  DatabaseIcon,
  Icon,
  InfoIcon,
  KeyRoundIcon,
  LogOutIcon,
  PaletteIcon,
  RadioTowerIcon,
  ShieldIcon,
  SmartphoneIcon,
  Trash2Icon,
  ZapIcon,
} from '@/components/icon';
import { ListRow, ListSection } from '@/components/list-row';
import { Screen, TabHeader } from '@/components/screen';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { describeRelay } from '@/nearby/relay';
import { useNearbyStatus, useRelay } from '@/nearby/service';
import { describeNearby } from '@/nearby/status';
import { removeDataFromThisPhone } from '@/recovery/remove-data';
import { useAccount } from '@/settings/account';
import { useTheme } from '@/theme/theme-root';
import { colorSchemes } from '@pingdost/ui-tokens';

export function SettingsScreen() {
  const router = useRouter();
  const { prefs, floating } = useTheme();
  const username = useAuth((state) => state.session?.user.username);
  const me = useAccount((state) => state.me);
  const nearby = describeNearby(useNearbyStatus());
  const relayState = useRelay();
  const relay = describeRelay(relayState.decision, relayState.prefs, relayState.mesh.stored);
  const scheme = colorSchemes.find((entry) => entry.id === prefs.scheme);
  const displayName = me?.displayName ?? username ?? 'PingDost';

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
    <View className="flex-1 bg-background">
      <TabHeader title="Settings" />
      <Screen tabRoot>
        <Tap
          accessibilityLabel={`${displayName}. Edit your profile`}
          scaleTo={0.98}
          feedback="selection"
          onPress={() => router.push('/profile')}
        >
          <Gradient className="flex-row items-center gap-4 rounded-2xl p-4" style={floating}>
            <Avatar url={me?.avatarUrl} name={displayName} size={68} />
            <View className="flex-1 gap-1">
              <Text numberOfLines={1} className="font-display text-2xl text-on-primary">
                {displayName}
              </Text>
              {username && (
                <Text numberOfLines={1} className="font-semibold text-on-primary/80">
                  @{username}
                </Text>
              )}
            </View>
            <Icon icon={ChevronRightIcon} size={22} color="on-primary" />
          </Gradient>
        </Tap>

        <ListSection>
          <ListRow
            icon={PaletteIcon}
            tone="secondary"
            title="Appearance"
            subtitle={`${scheme?.name ?? 'Colors'}, wallpaper, bubbles, fonts and more`}
            onPress={() => router.push('/appearance')}
          />
        </ListSection>

        <ListSection title="Account">
          <ListRow
            icon={ShieldIcon}
            title="Privacy"
            subtitle="Read receipts, typing, last seen"
            onPress={() => router.push('/privacy')}
          />
          <ListRow
            icon={BellIcon}
            title="Notifications"
            subtitle="Previews, sender name, battery"
            onPress={() => router.push('/notifications')}
          />
          <ListRow
            icon={SmartphoneIcon}
            title="Devices"
            subtitle="This phone and linked browsers"
            onPress={() => router.push('/devices')}
          />
          <ListRow
            icon={DatabaseIcon}
            title="Storage"
            subtitle="Space used, automatic downloads, clear cache"
            onPress={() => router.push('/storage')}
          />
          <ListRow
            icon={CloudUploadIcon}
            title="Backup"
            subtitle="An encrypted copy you keep, to move to a new phone"
            onPress={() => router.push('/backup')}
          />
        </ListSection>

        <ListSection title="Without internet">
          <ListRow
            icon={BluetoothIcon}
            title="Nearby messaging"
            subtitle={nearby.title}
            onPress={() => router.push('/nearby-messaging')}
          />
          <ListRow
            icon={RadioTowerIcon}
            title="Nearby relay"
            subtitle={relay.title}
            onPress={() => router.push('/nearby-relay')}
          />
        </ListSection>

        <ListSection title="About">
          <ListRow
            icon={InfoIcon}
            tone="muted"
            title="About privacy"
            onPress={() => router.push('/about-privacy')}
          />
        </ListSection>

        {__DEV__ && (
          <ListSection title="Developer">
            <ListRow
              icon={KeyRoundIcon}
              tone="muted"
              title="Crypto interop (dev)"
              onPress={() => router.push('/crypto')}
            />
            <ListRow
              icon={ZapIcon}
              tone="muted"
              title="Nearby spike (dev)"
              subtitle="Turn Nearby messaging off first: both read the same radio"
              onPress={() => router.push('/nearby')}
            />
          </ListSection>
        )}

        <ListSection>
          <ListRow icon={LogOutIcon} title="Log out" destructive onPress={confirmLogout} />
          <ListRow
            icon={Trash2Icon}
            title="Delete account"
            destructive
            onPress={() => router.push('/delete-account')}
          />
        </ListSection>
      </Screen>
    </View>
  );
}
