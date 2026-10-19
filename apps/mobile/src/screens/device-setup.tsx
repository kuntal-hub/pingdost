import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { authStore } from '@/api';
import { describeError } from '@/api/errors';
import { useAuth } from '@/auth/use-auth';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { setUpThisDevice } from '@/device';
import { DeviceSetupError, type DeviceSetupProblem } from '@/device/setup';
import { usePalette } from '@/theme/theme-root';
import { ApiError } from '@pingdost/api-client';

type SetupState =
  | { status: 'working' }
  | { status: 'problem'; problem: DeviceSetupProblem }
  | { status: 'error'; message: string };

const problems: Record<DeviceSetupProblem, { title: string; body: string }> = {
  primary_exists: {
    title: 'This account is active on another phone',
    body:
      'PingDost runs on one phone per account. Moving your account to this phone needs ' +
      'account recovery, which arrives in a later update. Until then, keep using your other ' +
      'phone, or log out and use a different account here.',
  },
  other_account: {
    title: 'This phone is set up for another account',
    body:
      'This phone holds the encryption keys of a different PingDost account. One phone ' +
      'holds one account for now. Log out and sign in with that account instead.',
  },
  username_required: {
    title: 'Choose a username first',
    body: 'Log out and sign in again to pick a username.',
  },
};

/**
 * After sign-in: registers this phone as the primary device. On success the session becomes
 * device-bound and the root layout moves on to the app.
 */
export function DeviceSetupScreen() {
  const palette = usePalette();
  const username = useAuth((state) => state.session?.user.username);
  const [state, setState] = useState<SetupState>({ status: 'working' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setUpThisDevice().catch((error: unknown) => {
      if (!active) return;
      if (error instanceof DeviceSetupError) {
        setState({ status: 'problem', problem: error.problem });
        return;
      }
      const described = describeError(error);
      // Local failures (e.g. the encrypted database) name their step; show it in dev builds.
      const detail = __DEV__ && error instanceof Error && !(error instanceof ApiError);
      setState({
        status: 'error',
        message: detail ? `${described.message} (${error.message})` : described.message,
      });
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  const logout = () => void authStore.getState().logout();

  if (state.status === 'problem') {
    const problem = problems[state.problem];
    return (
      <Screen title={problem.title} headerless>
        <Text className="text-base text-foreground">{problem.body}</Text>
        <Button label="Log out" variant="secondary" onPress={logout} />
      </Screen>
    );
  }

  return (
    <Screen
      title="Setting up this phone"
      subtitle={username ? `Signed in as @${username}` : undefined}
      offlineBanner
      headerless
    >
      {state.status === 'working' ? (
        <View className="flex-row items-center gap-3" accessibilityLiveRegion="polite">
          <ActivityIndicator color={palette.primary} />
          <Text className="flex-1 text-base text-foreground">
            Creating this phone&apos;s encryption keys and registering it with PingDost. Private
            keys never leave the phone.
          </Text>
        </View>
      ) : (
        <>
          <Notice tone="error" message={state.message} />
          <Button
            label="Try again"
            onPress={() => {
              setState({ status: 'working' });
              setAttempt((count) => count + 1);
            }}
          />
          <Button label="Log out" variant="ghost" onPress={logout} />
        </>
      )}
    </Screen>
  );
}
