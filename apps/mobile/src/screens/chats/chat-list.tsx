import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { OfflineBanner } from '@/components/offline-banner';
import { contactName } from '@/engine/contacts';
import { useContact, useConversations, type ChatListEntry } from '@/engine/hooks';
import { stateLabel } from '@/engine/labels';
import { dayLabel, timeLabel } from '@/engine/timeline';

function preview(entry: ChatListEntry): string {
  const last = entry.last;
  if (!last) return 'No messages yet';
  if (last.kind === 'system') return 'Safety number changed';
  if (last.kind === 'unsupported') return 'Update PingDost to see this message';
  return last.direction === 'out' ? `You: ${last.body}` : last.body;
}

function when(ms: number): string {
  const label = dayLabel(ms);
  return label === 'Today' ? timeLabel(ms) : label;
}

function ChatRow({ entry }: { entry: ChatListEntry }) {
  const router = useRouter();
  const { conversation, last } = entry;
  const contact = useContact(conversation.peerUserId);
  const name = contactName(contact);
  const status = last?.direction === 'out' && last.state ? stateLabel(last.state, true) : undefined;
  const unread = conversation.unreadCount;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${preview(entry)}${unread ? `. ${unread} unread` : ''}`}
      onPress={() =>
        router.push({
          pathname: '/chat/[conversationId]',
          params: { conversationId: conversation.conversationId },
        })
      }
      className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
    >
      <Avatar url={contact?.avatarUrl} name={name} size={48} />
      <View className="flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="flex-1 text-base font-semibold text-foreground">
            {name}
          </Text>
          {last && <Text className="text-muted">{when(last.sortAt)}</Text>}
        </View>
        <View className="flex-row items-center gap-2">
          {status && (
            <Text className={status.tone === 'danger' ? 'text-danger' : 'text-muted'}>
              {status.glyph}
            </Text>
          )}
          <Text numberOfLines={1} className="flex-1 text-muted">
            {preview(entry)}
          </Text>
          {unread > 0 && (
            <View className="min-w-[22px] items-center rounded-full bg-primary px-2">
              <Text className="font-semibold text-on-primary">{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function EmptyState() {
  return (
    <View className="items-center gap-2 px-6 py-8">
      <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
        No chats yet
      </Text>
      <Text className="text-center text-base text-muted">
        Start one with someone&apos;s exact username. Messages are end-to-end encrypted and kept on
        your devices.
      </Text>
    </View>
  );
}

export function ChatListScreen() {
  const router = useRouter();
  const { entries, loading } = useConversations();
  return (
    <View className="flex-1 bg-background">
      <View className="px-4 pt-2">
        <OfflineBanner />
      </View>
      <FlashList
        data={entries}
        keyExtractor={(entry) => entry.conversation.conversationId}
        renderItem={({ item }) => <ChatRow entry={item} />}
        ListEmptyComponent={loading ? null : <EmptyState />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 96 }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={() => router.push('/new-chat')}
        className="absolute bottom-6 right-5 flex-row items-center gap-2 rounded-lg bg-primary px-5 py-4 shadow active:opacity-80"
      >
        <Text className="text-xl font-semibold text-on-primary">+</Text>
        <Text className="text-base font-semibold text-on-primary">New chat</Text>
      </Pressable>
    </View>
  );
}
