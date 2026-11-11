// Settings → Circle, the contact screen and the chat list's Requests row (Phase 37, ADR 0041):
// the people in this user's circle (search, remove) and the requests (accept, decline, block;
// withdraw one's own).
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';

import { describeError } from '@/api/errors';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Segmented } from '@/components/controls';
import { EmptyState } from '@/components/feedback';
import { BanIcon, CheckIcon, UsersRoundIcon, XIcon } from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { Tap } from '@/components/tap';
import { Text, TextInput } from '@/components/text';
import { useBlocks } from '@/engine/blocks';
import { useCircle } from '@/engine/circle';
import { personName } from '@/engine/circle-logic';
import type { CirclePerson } from '@pingdost/shared-types';

import { useCircleChange } from './circle-action';

type Tab = 'circle' | 'requests';

function PersonRow({
  person,
  detail,
  onPress,
  children,
}: {
  person: CirclePerson;
  detail?: string;
  onPress?: () => void;
  children?: React.ReactNode;
}) {
  const name = personName(person);
  const handle = person.displayName && person.username ? `@${person.username}` : undefined;
  const body = (
    <View className="flex-row items-center gap-3 px-4 py-3">
      <Avatar url={person.avatarUrl} name={name} size={44} />
      <View className="flex-1">
        <Text numberOfLines={1} className="text-base font-semibold text-foreground">
          {name}
        </Text>
        {(handle ?? detail) && (
          <Text numberOfLines={1} className="text-muted">
            {[handle, detail].filter(Boolean).join(' · ')}
          </Text>
        )}
      </View>
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Tap
      accessibilityLabel={`${name}${handle ? `, ${handle}` : ''}. Contact info`}
      scaleTo={0.99}
      onPress={onPress}
      className="active:bg-raised"
    >
      {body}
    </Tap>
  );
}

function IncomingRow({ person }: { person: CirclePerson }) {
  const [busy, run] = useCircleChange();
  const circle = useCircle.getState();
  const name = personName(person);
  return (
    <PersonRow person={person} detail="Wants to join your circle">
      <View className="flex-row gap-1">
        <IconButton
          icon={BanIcon}
          label={`Block ${name}`}
          size={40}
          disabled={busy}
          onPress={() =>
            Alert.alert(`Block ${name}?`, 'They are not told. Their request goes away.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Block',
                style: 'destructive',
                onPress: () =>
                  run('Could not block', async () => {
                    await useBlocks.getState().block(person.userId);
                    await circle.load();
                  }),
              },
            ])
          }
        />
        <IconButton
          icon={XIcon}
          label={`Decline ${name}'s request`}
          variant="surface"
          size={40}
          disabled={busy}
          onPress={() => run('Could not decline', () => circle.decline(person.userId))}
        />
        <IconButton
          icon={CheckIcon}
          label={`Accept ${name}'s request`}
          variant="brand"
          size={40}
          disabled={busy}
          onPress={() => run('Could not accept', () => circle.accept(person.userId))}
        />
      </View>
    </PersonRow>
  );
}

function OutgoingRow({ person }: { person: CirclePerson }) {
  const [busy, run] = useCircleChange();
  return (
    <PersonRow person={person} detail="Requested">
      <Button
        label="Withdraw"
        variant="ghost"
        loading={busy}
        onPress={() =>
          run('Could not withdraw', () => useCircle.getState().withdraw(person.userId))
        }
      />
    </PersonRow>
  );
}

function MemberRow({ person }: { person: CirclePerson }) {
  const router = useRouter();
  const [busy, run] = useCircleChange();
  const name = personName(person);
  return (
    <PersonRow
      person={person}
      onPress={() =>
        router.push({ pathname: '/contact/[userId]', params: { userId: person.userId } })
      }
    >
      <IconButton
        icon={XIcon}
        label={`Remove ${name} from your circle`}
        size={40}
        disabled={busy}
        onPress={() =>
          Alert.alert(
            `Remove ${name}?`,
            'You can no longer message or call each other. They are not told, but they will see that you are no longer in their circle.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Remove',
                style: 'destructive',
                onPress: () =>
                  run('Could not remove', () => useCircle.getState().remove(person.userId)),
              },
            ],
          )
        }
      />
    </PersonRow>
  );
}

export function CircleScreen() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const members = useCircle((state) => state.members);
  const incoming = useCircle((state) => state.incoming);
  const outgoing = useCircle((state) => state.outgoing);
  const [tab, setTab] = useState<Tab>(params.tab === 'requests' ? 'requests' : 'circle');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void useCircle
      .getState()
      .load()
      .catch((caught: unknown) => setError(describeError(caught).message));
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/^@/, '');
    if (!needle) return members;
    return members.filter((m) =>
      [m.displayName, m.username].some((field) => field?.toLowerCase().includes(needle)),
    );
  }, [members, query]);

  return (
    <Screen offlineBanner>
      <Segmented
        accessibilityLabel="Circle or requests"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'circle', label: `Circle · ${members.length}` },
          {
            id: 'requests',
            label: incoming.length ? `Requests · ${incoming.length}` : 'Requests',
          },
        ]}
      />
      {tab === 'circle' ? (
        members.length === 0 ? (
          <EmptyState
            icon={UsersRoundIcon}
            title="Your circle is empty"
            message="Add people by their username from the + on the Chats tab. Once they accept, you can message and call each other."
          />
        ) : (
          <>
            <TextInput
              accessibilityLabel="Search your circle"
              placeholder="Search your circle"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              className="h-[48px] rounded-xl bg-surface px-4 text-base text-foreground"
            />
            {shown.length === 0 ? (
              <Text className="text-muted">No one in your circle matches “{query}”.</Text>
            ) : (
              <ListSection>
                {shown.map((member) => (
                  <MemberRow key={member.userId} person={member} />
                ))}
              </ListSection>
            )}
          </>
        )
      ) : incoming.length === 0 && outgoing.length === 0 ? (
        <EmptyState
          icon={UsersRoundIcon}
          title="No requests"
          message="When someone asks to join your circle, it shows here."
        />
      ) : (
        <>
          {incoming.length > 0 && (
            <ListSection title="Waiting for you">
              {incoming.map((request) => (
                <IncomingRow key={request.userId} person={request} />
              ))}
            </ListSection>
          )}
          {outgoing.length > 0 && (
            <ListSection title="Sent by you">
              {outgoing.map((request) => (
                <OutgoingRow key={request.userId} person={request} />
              ))}
            </ListSection>
          )}
          <Text className="text-muted">
            Declining is silent: they keep seeing “Requested” until the request expires after 30
            days.
          </Text>
        </>
      )}
      {error && <Notice tone="error" message={error} />}
      <Text className="text-muted">
        Only people in your circle can message you, call you or add you to a group. PingDost’s
        server keeps the list of who is in whose circle until either of you removes the other or
        deletes the account.
      </Text>
    </Screen>
  );
}
