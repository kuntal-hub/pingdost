// On the old phone: a new phone asked to take over this account (ADR 0022). The user compares
// the code with the new phone's screen, then approves (this phone is signed out when the new
// one finishes) or denies.
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { describeError } from '@/api/errors';
import { useAuth } from '@/auth/use-auth';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import {
  approvePhone,
  denyPhone,
  dismissPhoneRequest,
  usePhoneRequests,
  type PhoneRequest,
} from '@/recovery/approvals';

export function ApprovePhoneScreen() {
  const router = useRouter();
  const requests = usePhoneRequests((state) => state.requests);
  const deviceId = useAuth((state) => state.session?.deviceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const request: PhoneRequest | undefined = requests[0];

  const close = () => {
    if (request) dismissPhoneRequest(request.requestId);
    if (router.canGoBack()) router.back();
  };

  if (approved) {
    return (
      <Screen title="Approved">
        <Text className="text-base text-foreground">
          Finish on the new phone. When it is ready, this phone is signed out and its chats are
          removed from it.
        </Text>
        <Button label="OK" onPress={() => router.canGoBack() && router.back()} />
      </Screen>
    );
  }

  if (!request) {
    return (
      <Screen title="No requests">
        <Text className="text-base text-foreground">No new phone is waiting for approval.</Text>
        <Button label="Close" onPress={() => router.canGoBack() && router.back()} />
      </Screen>
    );
  }

  const approve = () =>
    Alert.alert(
      'Move your account to this new phone?',
      'This phone will be signed out and its chats deleted from it. Make a backup first (Settings → Backup) if you want to keep them.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setError(null);
            approvePhone(request).then(
              () => setApproved(true),
              (caught: unknown) => {
                setError(describeError(caught).message);
                setBusy(false);
              },
            );
          },
        },
      ],
    );

  const deny = () => {
    setBusy(true);
    setError(null);
    denyPhone(request.requestId).then(
      () => {
        setBusy(false);
        if (router.canGoBack()) router.back();
      },
      (caught: unknown) => {
        setError(describeError(caught).message);
        setBusy(false);
      },
    );
  };

  return (
    <Screen title="A new phone wants your account">
      <Text className="text-base text-foreground">
        “{request.name}” asked at {new Date(request.createdAt).toLocaleTimeString()} to become your
        PingDost phone. Approve only if you are setting up that phone yourself and it shows this
        code:
      </Text>
      <Text
        accessibilityLabel={`Code ${request.code.split('').join(' ')}`}
        className="text-center text-4xl font-bold tracking-widest text-foreground"
      >
        {request.code}
      </Text>
      <Notice
        tone="error"
        message="If you did not ask for this, deny it and change your password: someone else has it."
      />
      {error && <Notice tone="error" message={error} />}
      {deviceId && <Button label="The codes match: approve" loading={busy} onPress={approve} />}
      <Button label="Deny" variant="danger" disabled={busy} onPress={deny} />
      <Button label="Decide later" variant="ghost" disabled={busy} onPress={close} />
    </Screen>
  );
}
