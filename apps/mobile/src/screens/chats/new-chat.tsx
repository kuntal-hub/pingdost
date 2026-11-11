// New chat (Phase 38, ADR 0042): one field finds people by the start of their username or name,
// or by their whole email address. Circle members who match show at once (matched on this
// phone), then the server's results. Each row has one action: Message, Add to circle,
// Requested, or Accept.
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { api } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/feedback';
import { Icon, SearchIcon, UserPlusIcon } from '@/components/icon';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { Text, TextInput } from '@/components/text';
import { circleStateOf, useCircle, type CircleState } from '@/engine/circle';
import { personName } from '@/engine/circle-logic';
import { saveProfile } from '@/engine/contacts';
import { useChatRuntime } from '@/engine/hooks';
import { usePalette } from '@/theme/theme-root';
import { ApiError } from '@pingdost/api-client';
import { matchesPerson, mergePeople, searchable } from '@pingdost/chat-core';
import type { CirclePerson } from '@pingdost/shared-types';

import { useCircleChange } from '../circle/circle-action';

/** How long typing must pause before the server is asked. */
const DEBOUNCE_MS = 300;

interface Found extends CirclePerson {
  /** The server's view; the phone's own lists win once loaded. */
  circle: CircleState;
}

function searchError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED') return 'Too many searches for now. Wait a moment.';
    if (error.kind !== 'http') return 'You seem to be offline. Circle members still show.';
  }
  return 'The search did not work. Try again.';
}

function ResultRow({ person, self }: { person: Found; self: string | undefined }) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const local = useCircle((state) => circleStateOf(state, person.userId));
  const state = local ?? person.circle;
  const [busy, run] = useCircleChange();
  const [opening, setOpening] = useState(false);
  const circle = useCircle.getState();
  const name = personName(person);
  const handle = person.username ? `@${person.username}` : undefined;

  async function message() {
    if (!runtime) return;
    setOpening(true);
    try {
      if (person.username) {
        await saveProfile({
          userId: person.userId,
          username: person.username,
          displayName: person.displayName,
          avatarUrl: person.avatarUrl,
        });
      }
      const conversation = await runtime.engine.openDirectConversation(person.userId);
      router.replace({
        pathname: '/chat/[conversationId]',
        params: { conversationId: conversation.conversationId },
      });
    } catch {
      setOpening(false);
    }
  }

  if (person.userId === self) return null;
  return (
    <View className="flex-row items-center gap-3 px-4 py-3">
      <Avatar url={person.avatarUrl} name={name} size={44} />
      <View className="flex-1">
        <Text numberOfLines={1} className="text-base font-semibold text-foreground">
          {name}
        </Text>
        {person.displayName && handle && (
          <Text numberOfLines={1} className="text-muted">
            {handle}
          </Text>
        )}
      </View>
      {state === 'member' ? (
        <Button label="Message" loading={opening} onPress={() => void message()} />
      ) : state === 'incoming' ? (
        <Button
          label="Accept"
          loading={busy}
          onPress={() => run('Could not accept', () => circle.accept(person.userId))}
        />
      ) : state === 'requested' ? (
        <Button
          label="Requested"
          variant="ghost"
          loading={busy}
          accessibilityHint="Withdraws the request"
          onPress={() => run('Could not withdraw', () => circle.withdraw(person.userId))}
        />
      ) : (
        <Button
          label="Add"
          icon={UserPlusIcon}
          variant="secondary"
          loading={busy}
          accessibilityHint={`Asks ${name} to join your circle`}
          onPress={() => run('Could not send the request', () => circle.request(person.userId))}
        />
      )}
    </View>
  );
}

export function NewChatScreen() {
  const router = useRouter();
  const runtime = useChatRuntime();
  const palette = usePalette();
  const members = useCircle((state) => state.members);
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<Found[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef(0);

  // Circle members match on the phone at once; nothing leaves it.
  const local = useMemo<Found[]>(
    () =>
      query.trim() === ''
        ? []
        : members
            .filter((member) => matchesPerson(member, query))
            .map((member) => ({ ...member, circle: 'member' as const })),
    [members, query],
  );

  // The server's results after a pause in typing; an older answer never replaces a newer one.
  useEffect(() => {
    setError(undefined);
    if (!searchable(query)) {
      setRemote([]);
      setSearching(false);
      return;
    }
    const ticket = ++latest.current;
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      api.account
        .searchUsers(query.trim(), controller.signal)
        .then((results) => {
          if (ticket === latest.current) setRemote(results);
        })
        .catch((caught: unknown) => {
          if (ticket === latest.current && !controller.signal.aborted)
            setError(searchError(caught));
        })
        .finally(() => {
          if (ticket === latest.current) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const shown = mergePeople(local, remote);

  return (
    <Screen offlineBanner>
      <ListSection>
        <ListRow
          title="New group"
          subtitle="Chat with several people from your circle"
          onPress={() => router.push('/new-group')}
        />
      </ListSection>
      <View className="h-[52px] flex-row items-center gap-2 rounded-xl bg-surface px-4">
        <Icon icon={SearchIcon} size={20} color="muted" />
        <TextInput
          accessibilityLabel="Find people"
          placeholder="Name, @username or email"
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          returnKeyType="search"
          className="flex-1 text-base text-foreground"
        />
        {searching && <ActivityIndicator color={palette.accent} />}
      </View>
      {error && <Notice tone="error" message={error} />}
      {query.trim() === '' ? (
        <Text className="text-muted">
          Type the start of a name or username, or someone's whole email address. Emails are never
          shown, and a part of one finds nothing.
        </Text>
      ) : shown.length > 0 ? (
        <ListSection>
          {shown.map((person) => (
            <ResultRow key={person.userId} person={person} self={runtime?.userId} />
          ))}
        </ListSection>
      ) : (
        !searching &&
        searchable(query) && (
          <EmptyState
            icon={SearchIcon}
            title="No one found"
            message="Check the spelling, or ask them for their username. Some people turn off being found by name or email."
          />
        )
      )}
      {!runtime && <Notice message="Chats are starting. One moment…" />}
    </Screen>
  );
}
