import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { api } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { contactName, saveProfile, type Contact } from '@/engine/contacts';
import { useChatRuntime } from '@/engine/hooks';
import { ApiError } from '@pingdost/api-client';
import { UsernameSchema } from '@pingdost/shared-types';

function lookupError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NOT_FOUND') return 'No one has that username. Check the spelling.';
    if (error.code === 'RATE_LIMITED') return 'Too many lookups for now. Try again later.';
    if (error.kind !== 'http') return 'You seem to be offline. Connect and try again.';
  }
  return 'The lookup did not work. Try again.';
}

/** Find someone by their exact username (no search or suggestions), then start the chat. */
export function NewChatScreen() {
  const router = useRouter();
  const runtime = useChatRuntime();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string>();
  const [found, setFound] = useState<Contact>();
  const [busy, setBusy] = useState(false);

  async function find() {
    setError(undefined);
    setFound(undefined);
    const parsed = UsernameSchema.safeParse(username.replace(/^@/, ''));
    if (!parsed.success) {
      setError('Usernames are 3–20 letters, digits, _ or .');
      return;
    }
    setBusy(true);
    try {
      const profile = await api.account.lookupUsername(parsed.data);
      if (profile.userId === runtime?.userId)
        setError("That's you. Enter someone else's username.");
      else setFound(await saveProfile(profile));
    } catch (caught) {
      setError(lookupError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!found || !runtime) return;
    setBusy(true);
    try {
      const conversation = await runtime.engine.openDirectConversation(found.userId);
      router.replace({
        pathname: '/chat/[conversationId]',
        params: { conversationId: conversation.conversationId },
      });
    } catch {
      setError('The chat could not be opened. Try again.');
      setBusy(false);
    }
  }

  return (
    <Screen offlineBanner>
      <ListSection>
        <ListRow
          title="New group"
          subtitle="Chat with several people at once"
          onPress={() => router.push('/new-group')}
        />
      </ListSection>
      <TextField
        label="Username"
        value={username}
        onChangeText={(text) => {
          setUsername(text);
          setFound(undefined);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="search"
        onSubmitEditing={() => void find()}
        hint="The exact username, e.g. asha_k. PingDost has no people search."
        {...(error ? { error } : {})}
      />
      <Button
        label="Find"
        variant="secondary"
        loading={busy && !found}
        onPress={() => void find()}
      />
      {found && (
        <View className="items-center gap-3 rounded-lg border border-border bg-surface p-5">
          <Avatar url={found.avatarUrl} name={contactName(found)} size={72} />
          <View className="items-center gap-1">
            <Text className="text-lg font-semibold text-foreground">{contactName(found)}</Text>
            {found.displayName && found.username && (
              <Text className="text-muted">@{found.username}</Text>
            )}
          </View>
          <Button label="Message" loading={busy} onPress={() => void start()} />
        </View>
      )}
      {!runtime && <Notice message="Chats are starting. One moment…" />}
    </Screen>
  );
}
