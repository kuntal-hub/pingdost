import { useNetworkState } from 'expo-network';
import { Text, View } from 'react-native';

import { useNearbyPeer, useNearbyStatus } from '@/nearby/service';
import { describeNearby } from '@/nearby/status';

export interface BannerPeer {
  userId: string;
  name: string;
  /** Whether a message to them can be encrypted offline (null: not known yet). */
  reachable: boolean | null;
}

/**
 * "You're offline" while the phone reports no connection or no internet, and what nearby
 * messaging does meanwhile (ADR 0024): on, off, or why it cannot work. In a chat, `peer` says
 * whether this contact is in range, or cannot be reached offline at all.
 */
export function OfflineBanner({ peer }: { peer?: BannerPeer | undefined }) {
  const network = useNetworkState();
  const status = useNearbyStatus();
  const near = useNearbyPeer(peer?.userId);
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
    <View
      accessibilityLiveRegion="polite"
      className="rounded-md border border-border bg-surface px-4 py-3"
    >
      <Text className="font-semibold text-foreground">{title}</Text>
      <Text className="text-muted">{detail}</Text>
      {unreachable && (
        <Text className="text-danger">
          Can&apos;t reach this contact offline until you&apos;ve connected once online.
        </Text>
      )}
    </View>
  );
}
