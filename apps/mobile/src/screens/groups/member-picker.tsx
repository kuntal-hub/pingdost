import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { api } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { TextField } from '@/components/text-field';
import { contactName, saveProfile } from '@/engine/contacts';
import { useChatRuntime, useContact, useConversations } from '@/engine/hooks';
import { ApiError } from '@pingdost/api-client';
import { UsernameSchema } from '@pingdost/shared-types';

function Person({
  userId,
  selected,
  onToggle,
}: {
  userId: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const contact = useContact(userId);
  const name = contactName(contact);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={name}
      onPress={onToggle}
      className="min-h-[56px] flex-row items-center gap-3 px-4 py-2 active:opacity-70"
    >
      <Avatar url={contact?.avatarUrl} name={name} size={40} />
      <View className="flex-1">
        <Text className="text-base text-foreground">{name}</Text>
        {contact?.displayName && contact.username && (
          <Text className="text-muted">@{contact.username}</Text>
        )}
      </View>
      <View
        className={`h-[24px] w-[24px] items-center justify-center rounded-md border ${
          selected ? 'border-primary bg-primary' : 'border-border'
        }`}
      >
        {selected && <Text className="font-bold text-on-primary">✓</Text>}
      </View>
    </Pressable>
  );
}

/**
 * Picks people for a group: those this user already chats with, plus anyone added by exact
 * username (PingDost has no people search). `exclude`: current members.
 */
export function MemberPicker({
  selected,
  onChange,
  exclude = [],
}: {
  selected: string[];
  onChange: (userIds: string[]) => void;
  exclude?: string[];
}) {
  const runtime = useChatRuntime();
  const { entries } = useConversations();
  const [extra, setExtra] = useState<string[]>([]);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const known = entries
    .filter((e) => e.conversation.kind === 'direct')
    .map((e) => e.conversation.peerUserId);
  const people = [...new Set([...extra, ...known])].filter(
    (id) => id !== runtime?.userId && !exclude.includes(id),
  );

  function toggle(userId: string) {
    onChange(
      selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId],
    );
  }

  async function add() {
    setError(undefined);
    const parsed = UsernameSchema.safeParse(username.replace(/^@/, ''));
    if (!parsed.success) {
      setError('Usernames are 3–20 letters, digits, _ or .');
      return;
    }
    setBusy(true);
    try {
      const profile = await api.account.lookupUsername(parsed.data);
      if (profile.userId === runtime?.userId) {
        setError("That's you.");
      } else if (exclude.includes(profile.userId)) {
        setError('They are already in the group.');
      } else {
        await saveProfile(profile);
        setExtra((current) => [profile.userId, ...current.filter((id) => id !== profile.userId)]);
        if (!selected.includes(profile.userId)) onChange([...selected, profile.userId]);
        setUsername('');
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'NOT_FOUND'
          ? 'No one has that username. Check the spelling.'
          : 'The lookup did not work. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-3">
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextField
            label="Add by username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="search"
            onSubmitEditing={() => void add()}
            {...(error ? { error } : {})}
          />
        </View>
        <View className={error ? 'mb-6' : ''}>
          <Button label="Add" variant="secondary" loading={busy} onPress={() => void add()} />
        </View>
      </View>
      {people.length === 0 ? (
        <Text className="text-muted">
          People you chat with appear here. Add others by their exact username.
        </Text>
      ) : (
        <View className="overflow-hidden rounded-lg border border-border bg-surface">
          {people.map((userId) => (
            <Person
              key={userId}
              userId={userId}
              selected={selected.includes(userId)}
              onToggle={() => toggle(userId)}
            />
          ))}
        </View>
      )}
    </View>
  );
}
