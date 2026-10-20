import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { useCryptoContext } from '@/hooks/use-crypto-context';
import {
  INTEROP_STEPS,
  runInteropClient,
  runScenarios,
  verifyAttachmentVectors,
  verifyVectors,
  type AttachmentVectors,
  type CryptoVectors,
  type StepResult,
} from '@pingdost/crypto/conformance';
import attachmentVectors from '@pingdost/test-fixtures/crypto/attachment-stream-v1.json';
import storedVectors from '@pingdost/test-fixtures/crypto/vodozemac-0.11.1.json';

import { StepList } from './step-list';

// The interop server runs on the PC; `adb reverse tcp:8787 tcp:8787` makes it localhost.
const DEFAULT_INTEROP_URL = process.env.EXPO_PUBLIC_INTEROP_URL ?? 'http://localhost:8787';

function Button({ label, onPress, busy }: { label: string; onPress: () => void; busy: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      className="items-center rounded-md bg-primary p-3 active:opacity-80 disabled:opacity-50"
    >
      <Text className="font-semibold text-on-primary">{label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3 rounded-lg border border-border bg-surface p-4">
      <Text className="text-lg font-semibold text-foreground">{title}</Text>
      {children}
    </View>
  );
}

/** Dev-only proof screen for the Phase 3 crypto gate. */
export function DevCrypto() {
  const state = useCryptoContext();
  const [url, setUrl] = useState(DEFAULT_INTEROP_URL);
  const [localSteps, setLocalSteps] = useState<StepResult[]>([]);
  const [interopSteps, setInteropSteps] = useState<StepResult[]>([]);
  const [busy, setBusy] = useState(false);

  if (state.status === 'loading') return <ActivityIndicator className="mt-8" />;
  if (state.status === 'error') return <Text className="m-4 text-danger">{state.message}</Text>;
  const { provider, store } = state.context;

  const runLocal = () => {
    setBusy(true);
    // Let the spinner render before the synchronous scenarios block the JS thread.
    setTimeout(() => {
      const started = performance.now();
      const steps = [
        ...runScenarios(provider),
        ...verifyVectors(provider, storedVectors as CryptoVectors),
        ...verifyAttachmentVectors(provider, attachmentVectors as AttachmentVectors),
      ];
      const elapsed = Math.round(performance.now() - started);
      setLocalSteps([...steps, { id: 'time', title: `Ran in ${elapsed} ms`, ok: true }]);
      setBusy(false);
    }, 16);
  };

  const runInterop = async () => {
    setBusy(true);
    const steps: StepResult[] = [];
    setInteropSteps([]);
    await runInteropClient({
      provider,
      account: store.account,
      persistAccount: () => store.saveAccount(),
      baseUrl: url.replace(/\/+$/, ''),
      fetch: (input, init) => fetch(input, init),
      onStep: (step) => {
        steps.push(step);
        setInteropSteps([...steps]);
      },
    });
    setBusy(false);
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 p-4">
      <Text className="text-muted">{provider.implementation}</Text>

      <Section title="On-device conformance (native provider)">
        <Text className="text-muted">The Phase 2 scenarios plus the stored WASM vectors.</Text>
        <Button label="Run scenarios" onPress={runLocal} busy={busy} />
        <StepList steps={localSteps} />
      </Section>

      <Section title="Phone ↔ Node interop (WASM peer)">
        <Text className="text-muted">
          Start `pnpm --filter @pingdost/crypto interop-server`, then `adb reverse tcp:8787
          tcp:8787`.
        </Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          className="rounded-md border border-border bg-background p-3 text-foreground"
        />
        <Button label="Run interop" onPress={() => void runInterop()} busy={busy} />
        <StepList steps={interopSteps} expected={INTEROP_STEPS} />
      </Section>
      {busy && <ActivityIndicator />}
    </ScrollView>
  );
}
