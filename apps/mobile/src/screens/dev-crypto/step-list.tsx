import { View } from 'react-native';

import { CheckIcon, CircleAlertIcon, ClockIcon, Icon } from '@/components/icon';
import { Text } from '@/components/text';
import type { StepResult } from '@pingdost/crypto/conformance';

/** A mark per step; `expected` steps that have not run yet show as pending. */
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
          <View className="flex-row items-center gap-2">
            <Icon
              icon={step.ok ? CheckIcon : CircleAlertIcon}
              size={16}
              color={step.ok ? 'success' : 'danger'}
            />
            <Text className="flex-1 text-foreground">{step.title}</Text>
          </View>
          {step.detail && <Text className="ml-6 text-danger">{step.detail}</Text>}
        </View>
      ))}
      {steps.length > 0 &&
        pending.map((step) => (
          <View key={step.id} className="flex-row items-center gap-2">
            <Icon icon={ClockIcon} size={16} color="muted" />
            <Text className="flex-1 text-muted">{step.title}</Text>
          </View>
        ))}
    </View>
  );
}
