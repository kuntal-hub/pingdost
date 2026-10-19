import { useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';

import { describeError } from '@/api/errors';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { useBlocks } from '@/engine/blocks';
import { contactName } from '@/engine/contacts';
import { useContact } from '@/engine/hooks';

function BlockedRow({ userId }: { userId: string }) {
  const contact = useContact(userId);
  const name = contactName(contact);
  const [busy, setBusy] = useState(false);
  return (
    <ListRow
      title={name}
      {...(contact?.displayName && contact.username ? { subtitle: `@${contact.username}` } : {})}
      accessory={
        <Button
          label="Unblock"
          variant="secondary"
          loading={busy}
          onPress={() => {
            setBusy(true);
            useBlocks
              .getState()
              .unblock(userId)
              .catch(() => Alert.alert('Could not unblock', 'Check your connection and try again.'))
              .finally(() => setBusy(false));
          }}
        />
      }
    />
  );
}

/** The accounts this user blocked, with unblock. */
export function BlockedScreen() {
  const ids = useBlocks((state) => state.ids);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void useBlocks
      .getState()
      .load()
      .catch((caught: unknown) => setError(describeError(caught).message));
  }, []);

  return (
    <Screen offlineBanner>
      {ids.length === 0 ? (
        <Text className="text-muted">You have not blocked anyone.</Text>
      ) : (
        <ListSection>
          {ids.map((userId) => (
            <BlockedRow key={userId} userId={userId} />
          ))}
        </ListSection>
      )}
      {error && <Notice tone="error" message={error} />}
      <Text className="text-muted">
        Blocked people can still find your profile by username, but cannot message you, see when you
        are online or see you typing. They are not told. Messages they send are dropped by the
        server, and still look sent to them.
      </Text>
    </Screen>
  );
}
