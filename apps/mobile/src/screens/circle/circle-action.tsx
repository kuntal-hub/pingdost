// The circle action for one person (Phase 37, ADR 0041): ask them in, withdraw the request, or
// answer theirs. Used on the new-chat result, the contact screen and in place of the composer.
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { Button } from '@/components/button';
import { CheckIcon, UserPlusIcon } from '@/components/icon';
import { Text } from '@/components/text';
import { useCircle, useCircleState } from '@/engine/circle';
import { haptic } from '@/theme/motion';
import { ApiError } from '@pingdost/api-client';

export function circleError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED') return 'You sent many requests today. Try again tomorrow.';
    if (error.code === 'CIRCLE_LIMIT_REACHED')
      return 'Your circle or your waiting requests are full. Remove someone or withdraw a request first.';
    if (error.code === 'CONFLICT') return 'You blocked them. Unblock them first.';
    if (error.code === 'NOT_FOUND') return 'That request is no longer there.';
    if (error.kind !== 'http') return 'You seem to be offline. Connect and try again.';
  }
  return 'That did not work. Try again.';
}

/** Runs a circle change with a busy flag and an alert on failure. */
export function useCircleChange(): [
  boolean,
  (title: string, change: () => Promise<unknown>) => void,
] {
  const [busy, setBusy] = useState(false);
  return [
    busy,
    (title, change) => {
      setBusy(true);
      change()
        .then(() => haptic('success'))
        .catch((error: unknown) => {
          haptic('error');
          Alert.alert(title, circleError(error));
        })
        .finally(() => setBusy(false));
    },
  ];
}

/** Nothing once they are in the circle (or before the lists load). */
export function CircleAction({ userId, name }: { userId: string; name: string }) {
  const state = useCircleState(userId);
  const [busy, run] = useCircleChange();
  const circle = useCircle.getState();
  if (state === undefined || state === 'member') return null;
  if (state === 'incoming') {
    return (
      <View className="gap-2">
        <Text className="text-center text-muted">{name} asked to join your circle.</Text>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              label="Decline"
              variant="secondary"
              disabled={busy}
              onPress={() => run('Could not decline', () => circle.decline(userId))}
            />
          </View>
          <View className="flex-1">
            <Button
              label="Accept"
              icon={CheckIcon}
              loading={busy}
              onPress={() => run('Could not accept', () => circle.accept(userId))}
            />
          </View>
        </View>
      </View>
    );
  }
  if (state === 'requested') {
    return (
      <View className="gap-2">
        <Text className="text-center text-muted">
          Requested. You can message {name} once they accept.
        </Text>
        <Button
          label="Withdraw request"
          variant="ghost"
          loading={busy}
          onPress={() => run('Could not withdraw', () => circle.withdraw(userId))}
        />
      </View>
    );
  }
  return (
    <Button
      label="Add to circle"
      icon={UserPlusIcon}
      loading={busy}
      accessibilityHint={`Asks ${name} to join your circle. You can message each other once they accept.`}
      onPress={() => run('Could not send the request', () => circle.request(userId))}
    />
  );
}
