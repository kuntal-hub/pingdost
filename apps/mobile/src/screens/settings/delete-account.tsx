// Settings → Delete account (Phase 27, ADR 0036): what goes, what stays with other people,
// then an email code. Afterwards the phone is wiped and shows the welcome screen.
import { useRouter } from 'expo-router';

import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { deleteAccount, sendDeletionCode } from '@/recovery/delete-account';
import { CodeStep } from '@/screens/recovery/new-phone';

export function DeleteAccountScreen() {
  const router = useRouter();
  return (
    <Screen>
      <Notice
        tone="error"
        message="This deletes your PingDost account for good. It cannot be undone."
      />
      <Text className="text-base text-foreground">
        Your account, username, profile, groups you belong to, blocked contacts and every linked
        browser are removed. This phone and your browsers lose all PingDost data, including chat
        history. Make a backup first if you want to keep your chats elsewhere: a backup cannot be
        restored once the account is gone.
      </Text>
      <Text className="text-muted">
        Messages you already sent stay on the devices of the people who got them. Messages on their
        way to you are deleted from the server.
      </Text>
      <CodeStep
        action="Delete my account"
        danger
        sendCode={sendDeletionCode}
        onConfirm={deleteAccount}
        onBack={() => router.back()}
      />
    </Screen>
  );
}
