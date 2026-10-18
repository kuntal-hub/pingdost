import { Link } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { useCryptoContext } from '@/hooks/use-crypto-context';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between gap-3 py-1">
      <Text className="text-muted">{label}</Text>
      <Text className="shrink text-right font-medium text-foreground">{value}</Text>
    </View>
  );
}

/** Phase 3 shell: shows that encrypted storage and the device identity are ready. */
export function Home() {
  const state = useCryptoContext();

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 p-4">
      <Text className="text-2xl font-bold text-foreground">PingDost</Text>

      <View className="gap-1 rounded-lg border border-border bg-surface p-4">
        <Text className="mb-2 text-lg font-semibold text-foreground">This device</Text>
        {state.status === 'loading' && <ActivityIndicator />}
        {state.status === 'error' && <Text className="text-danger">{state.message}</Text>}
        {state.status === 'ready' && (
          <>
            <Row
              label="Local database"
              value={`SQLCipher ${state.context.database.cipherVersion}`}
            />
            <Row label="Schema version" value={String(state.context.database.schemaVersion)} />
            <Row
              label="Device account"
              value={state.context.store.accountCreated ? 'created now' : 'restored from pickle'}
            />
            <Row
              label="Identity key (Curve25519)"
              value={state.context.store.account.identityKeys().curve25519}
            />
            <Row label="Crypto ready in" value={`${state.context.timings.totalMs} ms`} />
          </>
        )}
      </View>

      {__DEV__ && (
        <Link href="/crypto" asChild>
          <Pressable
            accessibilityRole="button"
            className="items-center rounded-lg bg-primary p-4 active:opacity-80"
          >
            <Text className="font-semibold text-on-primary">Crypto interop (dev)</Text>
          </Pressable>
        </Link>
      )}
    </ScrollView>
  );
}
