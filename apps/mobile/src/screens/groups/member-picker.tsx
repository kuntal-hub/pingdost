// Picks group members (Phase 38, ADR 0042): only people in the circle (Phase 37: the server
// refuses anyone else), matched on this phone on every keystroke by name and username. A whole
// email address goes through the server search and keeps only circle members. Several at once;
// people already in the group show as members and cannot be picked.
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { api } from '@/api';
import { Avatar } from '@/components/avatar';
import { CheckMark } from '@/components/controls';
import { Icon, SearchIcon, XIcon } from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text, TextInput } from '@/components/text';
import { useCircle } from '@/engine/circle';
import { personName } from '@/engine/circle-logic';
import { isWholeEmail, matchesPerson, togglePicked } from '@pingdost/chat-core';
import type { CirclePerson } from '@pingdost/shared-types';

function Person({
  person,
  selected,
  member,
  onToggle,
}: {
  person: CirclePerson;
  selected: boolean;
  /** Already in the group. */
  member: boolean;
  onToggle: () => void;
}) {
  const name = personName(person);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected || member, disabled: member }}
      accessibilityLabel={member ? `${name}, already in the group` : name}
      disabled={member}
      onPress={onToggle}
      className={`min-h-[60px] flex-row items-center gap-3 px-4 py-2 active:bg-raised ${
        member ? 'opacity-60' : ''
      }`}
    >
      <Avatar url={person.avatarUrl} name={name} size={40} />
      <View className="flex-1">
        <Text numberOfLines={1} className="text-base font-bold text-foreground">
          {name}
        </Text>
        <Text numberOfLines={1} className="text-muted">
          {member
            ? 'Already in the group'
            : person.displayName && person.username
              ? `@${person.username}`
              : ''}
        </Text>
      </View>
      <CheckMark checked={selected || member} />
    </Pressable>
  );
}

export function MemberPicker({
  selected,
  onChange,
  exclude = [],
}: {
  selected: string[];
  onChange: (userIds: string[]) => void;
  /** Current members: shown, not pickable. */
  exclude?: string[];
}) {
  const members = useCircle((state) => state.members);
  const [query, setQuery] = useState('');
  const [byEmail, setByEmail] = useState<CirclePerson[]>([]);

  useEffect(() => {
    void useCircle
      .getState()
      .load()
      .catch(() => undefined);
  }, []);

  // A whole email: the server finds the address; only circle members can be added.
  useEffect(() => {
    setByEmail([]);
    if (!isWholeEmail(query)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.account
        .searchUsers(query.trim(), controller.signal)
        .then((results) => setByEmail(results.filter((r) => r.circle === 'member')))
        .catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const shown = useMemo(() => {
    const local = members.filter((member) => matchesPerson(member, query));
    const seen = new Set(local.map((m) => m.userId));
    return [...local, ...byEmail.filter((p) => !seen.has(p.userId))];
  }, [members, query, byEmail]);
  const picked = selected
    .map((id) => members.find((m) => m.userId === id) ?? byEmail.find((p) => p.userId === id))
    .filter((p): p is CirclePerson => p !== undefined);

  const toggle = (userId: string) => onChange(togglePicked(selected, userId));

  return (
    <View className="gap-3">
      {picked.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2"
          accessibilityLabel={`${picked.length} picked`}
        >
          {picked.map((person) => (
            <Tap
              key={person.userId}
              accessibilityLabel={`Remove ${personName(person)}`}
              feedback="selection"
              onPress={() => toggle(person.userId)}
              className="min-h-[40px] flex-row items-center gap-2 rounded-full bg-accent/15 pl-1 pr-3"
            >
              <Avatar url={person.avatarUrl} name={personName(person)} size={30} />
              <Text numberOfLines={1} className="max-w-[140px] font-semibold text-foreground">
                {personName(person)}
              </Text>
              <Icon icon={XIcon} size={16} color="accent" />
            </Tap>
          ))}
        </ScrollView>
      )}
      <View className="h-[48px] flex-row items-center gap-2 rounded-xl bg-surface px-4">
        <Icon icon={SearchIcon} size={18} color="muted" />
        <TextInput
          accessibilityLabel="Search your circle"
          placeholder="Search your circle, or a whole email"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          className="flex-1 text-base text-foreground"
        />
      </View>
      {members.length === 0 ? (
        <Text className="text-muted">
          Only people in your circle can be added to a group. Add people to your circle from the +
          on the Chats tab.
        </Text>
      ) : shown.length === 0 ? (
        <Text className="text-muted">No one in your circle matches “{query}”.</Text>
      ) : (
        <View className="overflow-hidden rounded-lg border border-border bg-surface">
          {shown.map((person) => (
            <Person
              key={person.userId}
              person={person}
              member={exclude.includes(person.userId)}
              selected={selected.includes(person.userId)}
              onToggle={() => toggle(person.userId)}
            />
          ))}
        </View>
      )}
    </View>
  );
}
