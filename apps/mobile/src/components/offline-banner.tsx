import { useNetworkState } from 'expo-network';
import { Text, View } from 'react-native';

/** "You're offline" while the phone reports no connection or no internet. */
export function OfflineBanner() {
  const network = useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  if (!offline) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      className="rounded-md border border-border bg-surface px-4 py-3"
    >
      <Text className="font-semibold text-foreground">You&apos;re offline</Text>
      <Text className="text-muted">Connect to the internet to continue.</Text>
    </View>
  );
}
