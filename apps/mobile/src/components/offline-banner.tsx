import { useNetworkState } from 'expo-network';
import { View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';

import { useNearbyPeer, useNearbyStatus } from '@/nearby/service';
import { describeNearby } from '@/nearby/status';
import { useMotion } from '@/theme/motion';

import { BluetoothIcon, Icon, WifiOffIcon } from './icon';
import { Text } from './text';

export interface BannerPeer {
  userId: string;
  name: string;
  /** Whether a message to them can be encrypted offline (null: not known yet). */
  reachable: boolean | null;
}

const ENTER = FadeInUp.duration(220);
const EXIT = FadeOutUp.duration(180);

/**
 * "You're offline" while the phone reports no connection or no internet, and what nearby
 * messaging does meanwhile (ADR 0024): on, off, or why it cannot work. In a chat, `peer` says
 * whether this contact is in range, or cannot be reached offline at all.
 */
export function OfflineBanner({ peer }: { peer?: BannerPeer | undefined }) {
  const network = useNetworkState();
  const status = useNearbyStatus();
  const near = useNearbyPeer(peer?.userId);
  const { fades } = useMotion();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  if (!offline) return null;

  let title = 'You’re offline';
  let detail = 'Connect to the internet to continue.';
  if (status.kind === 'on') {
    title = 'No internet — nearby messaging is on';
    detail = peer
      ? near
        ? `${peer.name}’s phone is nearby: messages go directly over Bluetooth.`
        : `Messages wait on this phone until ${peer.name}’s phone is nearby or the internet is back.`
      : describeNearby(status).title;
  } else if (status.kind === 'off') {
    detail =
      'Connect to the internet, or turn on Nearby messaging in Settings to reach contacts close by.';
  } else if (status.kind !== 'unavailable') {
    const text = describeNearby(status);
    detail = `Nearby messaging: ${text.title}. ${text.detail}`;
  }
  const unreachable =
    peer?.reachable === false && status.kind !== 'off' && status.kind !== 'unavailable';

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      {...(fades ? { entering: ENTER, exiting: EXIT } : {})}
    >
      {/* Solid underneath: in a chat this floats over the messages, which must not show through. */}
      <View className="overflow-hidden rounded-lg bg-surface">
        <View className="flex-row gap-3 bg-warning/15 px-4 py-3">
          <Icon
            icon={status.kind === 'on' ? BluetoothIcon : WifiOffIcon}
            size={20}
            color="warning"
          />
          <View className="flex-1 gap-1">
            <Text className="font-bold text-foreground">{title}</Text>
            <Text className="text-foreground">{detail}</Text>
            {unreachable && (
              <Text className="font-semibold text-danger">
                Can&apos;t reach this contact offline until you&apos;ve connected once online.
              </Text>
            )}
          </View>
        </View>
      </View>
    </Animated.View>
  );
}
