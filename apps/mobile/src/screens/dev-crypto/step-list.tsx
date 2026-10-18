import { Text, View } from 'react-native';

import type { StepResult } from '@pingdost/crypto/conformance';

/** ✅ / ❌ per step; `expected` steps that have not run yet show as pending. */
export function StepList({
  steps,
  expected = [],
}: {
  steps: StepResult[];
  expected?: readonly { id: string; title: string }[];
}) {
  const pending = expected.filter((step) => !steps.some((done) => done.id === step.id));
  return (
    <View className="gap-2">
      {steps.map((step) => (
        <View key={step.id} testID={`step-${step.id}`}>
          <Text className="text-foreground">
            {step.ok ? '✅' : '❌'} {step.title}
          </Text>
          {step.detail && <Text className="ml-6 text-danger">{step.detail}</Text>}
        </View>
      ))}
      {steps.length > 0 &&
        pending.map((step) => (
          <Text key={step.id} className="text-muted">
            ⏸ {step.title}
          </Text>
        ))}
    </View>
  );
}
