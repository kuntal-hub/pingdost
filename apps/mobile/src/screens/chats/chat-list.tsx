import { FlashList } from '@shopify/flash-list';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { NotificationPrompt } from '@/components/notification-prompt';
import { OfflineBanner } from '@/components/offline-banner';
import { contactName } from '@/engine/contacts';
import { groupPictureUri, useGroup, useNames } from '@/engine/groups';
import {
  useChatRuntime,
  useContact,
  useConversations,
  useReadReceipts,
  type ChatListEntry,
} from '@/engine/hooks';
import { previewText, shownState, stateLabel, type Names } from '@/engine/labels';
import { dayLabel, timeLabel } from '@/engine/timeline';
import { MUTED_FOREVER, type ConversationRecord } from '@pingdost/message-engine';

/** Chats that can be pinned at once. */
const MAX_PINNED = 3;
const HOUR = 3_600_000;

function preview(entry: ChatListEntry, names: Names): string {
  const last = entry.last;
  if (!last) return 'No messages yet';
  const text = previewText(last, names);
  if (last.kind === 'system' || last.kind === 'deleted') return text;
  if (last.direction === 'out') return `You: ${text}`;
  // In a group, say who wrote it.
  return entry.conversation.kind === 'group' ? `${names.name(last.senderUserId)}: ${text}` : text;
}

function when(ms: number): string {
  const label = dayLabel(ms);
  return label === 'Today' ? timeLabel(ms) : label;
}

export function isMuted(conversation: ConversationRecord, now = Date.now()): boolean {
  return conversation.mutedUntil !== null && conversation.mutedUntil > now;
}

/** Pinned chats first (most recently pinned on top), then by latest activity. */
function ordered(entries: ChatListEntry[]): ChatListEntry[] {
  return [...entries].sort(
    (a, b) =>
      (b.conversation.pinnedAt ?? -1) - (a.conversation.pinnedAt ?? -1) ||
      b.conversation.updatedAt - a.conversation.updatedAt,
  );
}

function ChatRow({
  entry,
  onLongPress,
}: {
  entry: ChatListEntry;
  onLongPress: (entry: ChatListEntry, name: string) => void;
}) {
  const router = useRouter();
  const readReceipts = useReadReceipts();
  const names = useNames();
  const { conversation, last } = entry;
  const isGroup = conversation.kind === 'group';
  const contact = useContact(isGroup ? undefined : conversation.peerUserId);
  const group = useGroup(isGroup ? conversation.conversationId : undefined);
  const name = isGroup ? group?.name || 'Group' : contactName(contact);
  const picture = isGroup ? groupPictureUri(group?.avatar) : contact?.avatarUrl;
  const text = preview(entry, names);
  const status =
    last?.direction === 'out' && last.state && last.kind !== 'deleted'
      ? stateLabel(shownState(last.state, readReceipts), true)
      : undefined;
  const unread = conversation.unreadCount;
  const muted = isMuted(conversation);
  const pinned = conversation.pinnedAt !== null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${isGroup ? ', group' : ''}${pinned ? ', pinned' : ''}${muted ? ', muted' : ''}. ${text}${unread ? `. ${unread} unread` : ''}`}
      accessibilityHint="Long press for chat options"
      onPress={() =>
        router.push({
          pathname: '/chat/[conversationId]',
          params: { conversationId: conversation.conversationId },
        })
      }
      onLongPress={() => onLongPress(entry, name)}
      className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
    >
      <Avatar url={picture} name={name} size={48} />
      <View className="flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="flex-1 text-base font-semibold text-foreground">
            {name}
          </Text>
          {muted && <Text importantForAccessibility="no">🔕</Text>}
          {pinned && <Text importantForAccessibility="no">📌</Text>}
          {last && <Text className="text-muted">{when(last.sortAt)}</Text>}
        </View>
        <View className="flex-row items-center gap-2">
          {status && (
            <Text className={status.tone === 'danger' ? 'text-danger' : 'text-muted'}>
              {status.glyph}
            </Text>
          )}
          <Text
            numberOfLines={1}
            className={`flex-1 text-muted ${last?.kind === 'deleted' ? 'italic' : ''}`}
          >
            {text}
          </Text>
          {unread > 0 && (
            <View
              className={`min-w-[22px] items-center rounded-full px-2 ${muted ? 'bg-muted' : 'bg-primary'}`}
            >
              <Text className="font-semibold text-on-primary">{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function EmptyState({ archived }: { archived: boolean }) {
  return (
    <View className="items-center gap-2 px-6 py-8">
      <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
        {archived ? 'No archived chats' : 'No chats yet'}
      </Text>
      <Text className="text-center text-base text-muted">
        {archived
          ? 'Archive a chat from its menu (long press) to keep it out of your list.'
          : 'Start one with someone’s exact username. Messages are end-to-end encrypted and kept on your devices.'}
      </Text>
    </View>
  );
}

/** The chat list, or (with `archived`) the archived chats. */
export function ChatListScreen({ archived = false }: { archived?: boolean }) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const { entries, loading } = useConversations();
  const [menu, setMenu] = useState<{ entry: ChatListEntry; name: string }>();
  const [muting, setMuting] = useState<ConversationRecord>();

  const shown = ordered(entries.filter((e) => e.conversation.archived === archived));
  const archivedEntries = entries.filter((e) => e.conversation.archived);
  const archivedUnread = archivedEntries.reduce((n, e) => n + e.conversation.unreadCount, 0);
  const pinnedCount = entries.filter((e) => e.conversation.pinnedAt !== null).length;

  const actions: SheetAction[] = [];
  if (menu && runtime) {
    const { conversation } = menu.entry;
    const { conversationId } = conversation;
    const { engine } = runtime;
    const pinned = conversation.pinnedAt !== null;
    actions.push({
      label: pinned ? 'Unpin' : 'Pin to top',
      onPress: () => {
        if (!pinned && pinnedCount >= MAX_PINNED) {
          Alert.alert('Pin limit', `You can pin up to ${MAX_PINNED} chats. Unpin one first.`);
          return;
        }
        void engine.setPinned(conversationId, !pinned);
      },
    });
    actions.push({
      label: conversation.archived ? 'Unarchive' : 'Archive',
      ...(conversation.archived
        ? {}
        : { detail: 'Moves it to Archived. New messages keep it there.' }),
      onPress: () => void engine.setArchived(conversationId, !conversation.archived),
    });
    actions.push(
      isMuted(conversation)
        ? { label: 'Unmute', onPress: () => void engine.setMuted(conversationId, null) }
        : { label: 'Mute…', onPress: () => setMuting(conversation) },
    );
    const isGroup = conversation.kind === 'group';
    actions.push({
      label: 'Delete chat',
      destructive: true,
      onPress: () =>
        Alert.alert(
          'Delete this chat?',
          isGroup
            ? 'Its messages are removed from this phone; the other members keep theirs. You must have left the group (Group info → Leave group).'
            : `Its messages and attachments are removed from this phone. ${menu.name} keeps their copy, and a new message starts a fresh chat.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () =>
                void engine
                  .deleteConversation(conversationId)
                  .catch(() =>
                    Alert.alert('Leave the group first', 'Open Group info and choose Leave group.'),
                  ),
            },
          ],
        ),
    });
  }

  const muteFor = (until: number) => {
    if (muting && runtime) void runtime.engine.setMuted(muting.conversationId, until);
  };

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Search chats"
              onPress={() => router.push('/search')}
              className="min-h-[44px] justify-center px-2 active:opacity-70"
            >
              <Text className="text-base text-primary">Search</Text>
            </Pressable>
          ),
        }}
      />
      <View className="gap-2 px-4 pt-2">
        <OfflineBanner />
        {!archived && <NotificationPrompt />}
      </View>
      <FlashList
        data={shown}
        keyExtractor={(entry) => entry.conversation.conversationId}
        renderItem={({ item }) => (
          <ChatRow entry={item} onLongPress={(entry, name) => setMenu({ entry, name })} />
        )}
        ListHeaderComponent={
          !archived && archivedEntries.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Archived chats, ${archivedEntries.length}${archivedUnread ? `, ${archivedUnread} unread` : ''}`}
              onPress={() => router.push('/archived')}
              className="min-h-[52px] flex-row items-center gap-3 px-4 py-3 active:opacity-70"
            >
              <Text className="flex-1 text-base text-foreground">
                Archived ({archivedEntries.length})
              </Text>
              {archivedUnread > 0 && <Text className="text-muted">{archivedUnread} unread</Text>}
              <Text className="text-xl text-muted">›</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={loading ? null : <EmptyState archived={archived} />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 96 }}
      />
      {!archived && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={() => router.push('/new-chat')}
          className="absolute bottom-6 right-5 flex-row items-center gap-2 rounded-lg bg-primary px-5 py-4 shadow active:opacity-80"
        >
          <Text className="text-xl font-semibold text-on-primary">+</Text>
          <Text className="text-base font-semibold text-on-primary">New chat</Text>
        </Pressable>
      )}

      <ActionSheet
        visible={menu !== undefined}
        onClose={() => setMenu(undefined)}
        {...(menu ? { title: menu.name } : {})}
        actions={actions}
      />
      <ActionSheet
        visible={muting !== undefined}
        onClose={() => setMuting(undefined)}
        title="Mute this chat? Its messages still arrive; muted chats will not notify you."
        actions={[
          { label: 'For 8 hours', onPress: () => muteFor(Date.now() + 8 * HOUR) },
          { label: 'For 1 week', onPress: () => muteFor(Date.now() + 7 * 24 * HOUR) },
          { label: 'Until I unmute', onPress: () => muteFor(MUTED_FOREVER) },
        ]}
      />
    </View>
  );
}
