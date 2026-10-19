import { FlashList } from '@shopify/flash-list';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { HighlightedText } from '@/components/highlighted-text';
import { contactName } from '@/engine/contacts';
import { requestJump, useChatRuntime, useContact } from '@/engine/hooks';
import { dayLabel, timeLabel } from '@/engine/timeline';
import { usePalette } from '@/theme/theme-root';
import type { ConversationRecord, MessageRecord } from '@pingdost/message-engine';

const DEBOUNCE_MS = 200;

function when(ms: number): string {
  const label = dayLabel(ms);
  return label === 'Today' ? timeLabel(ms) : label;
}

function ResultRow({
  message,
  query,
  peerUserId,
  selfUserId,
  showChat,
  onPress,
}: {
  message: MessageRecord;
  query: string;
  peerUserId: string | undefined;
  selfUserId: string;
  showChat: boolean;
  onPress: () => void;
}) {
  const contact = useContact(peerUserId);
  const name = contactName(contact);
  const from = message.senderUserId === selfUserId ? 'You' : name;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${showChat ? `${name}. ` : ''}${from}: ${message.body}. ${when(message.sortAt)}`}
      onPress={onPress}
      className="gap-1 border-b border-border px-4 py-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={1} className="flex-1 font-semibold text-foreground">
          {showChat ? name : from}
        </Text>
        <Text className="text-muted">{when(message.sortAt)}</Text>
      </View>
      <HighlightedText
        text={showChat ? `${from}: ${message.body}` : message.body}
        query={query}
        numberOfLines={3}
        className="text-base text-muted"
      />
    </Pressable>
  );
}

/**
 * Local search (REQ §8.1): every chat, or one chat when `conversationId` is given. It runs
 * on this phone's encrypted index only; nothing is sent anywhere.
 */
export function SearchScreen({ conversationId }: { conversationId?: string | undefined }) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const palette = usePalette();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessageRecord[]>([]);
  const [searched, setSearched] = useState('');
  const [peers, setPeers] = useState<Record<string, ConversationRecord>>({});

  useEffect(() => {
    if (!runtime) return;
    void runtime.engine
      .listConversations()
      .then((conversations) =>
        setPeers(Object.fromEntries(conversations.map((c) => [c.conversationId, c]))),
      );
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    const timer = setTimeout(() => {
      void runtime.engine.search(query, conversationId ? { conversationId } : {}).then((found) => {
        if (!live) return;
        setResults(found);
        setSearched(query);
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [runtime, query, conversationId]);

  function open(message: MessageRecord) {
    if (conversationId) {
      requestJump(conversationId, message.messageId);
      router.back();
      return;
    }
    router.push({
      pathname: '/chat/[conversationId]',
      params: { conversationId: message.conversationId, messageId: message.messageId },
    });
  }

  const trimmed = searched.trim();
  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ title: conversationId ? 'Search this chat' : 'Search chats' }} />
      <View className="px-4 py-3">
        <TextInput
          accessibilityLabel="Search messages"
          placeholder="Search messages"
          placeholderTextColor={palette.muted}
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          className="min-h-[48px] rounded-lg border border-border bg-surface px-3 text-base text-foreground"
        />
      </View>
      <FlashList
        data={results}
        keyExtractor={(message) => message.messageId}
        renderItem={({ item }) => (
          <ResultRow
            message={item}
            query={searched}
            peerUserId={peers[item.conversationId]?.peerUserId}
            selfUserId={runtime?.userId ?? ''}
            showChat={!conversationId}
            onPress={() => open(item)}
          />
        )}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text className="mx-6 my-8 text-center text-muted">
            {trimmed === ''
              ? 'Search the messages kept on this phone. The search runs only here.'
              : `No messages match “${trimmed}”.`}
          </Text>
        }
      />
    </View>
  );
}
