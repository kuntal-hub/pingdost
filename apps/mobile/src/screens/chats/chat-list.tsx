import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { Chip, ChipRow } from '@/components/controls';
import { EmptyState, SkeletonRows } from '@/components/feedback';
import { useTabBarInset } from '@/components/floating-tab-bar';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  BellOffIcon,
  ChevronRightIcon,
  FileIcon,
  Icon,
  ImageIcon,
  MicIcon,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UsersRoundIcon,
  VideoIcon,
  type LucideIcon,
} from '@/components/icon';
import { NotificationPrompt } from '@/components/notification-prompt';
import { OfflineBanner } from '@/components/offline-banner';
import { TabHeader } from '@/components/screen';
import { StateTick } from '@/components/state-tick';
import { SwipeAction } from '@/components/swipe-action';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { contactName } from '@/engine/contacts';
import { groupPictureUri, useGroup, useNames } from '@/engine/groups';
import {
  useChatRuntime,
  useContact,
  useConversations,
  useReadReceipts,
  type ChatListEntry,
} from '@/engine/hooks';
import { attachmentType, previewText, shownState, stateLabel, type Names } from '@/engine/labels';
import { dayLabel, timeLabel } from '@/engine/timeline';
import { CSS_POP, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';
import { MUTED_FOREVER, type ConversationRecord } from '@pingdost/message-engine';

/** Chats that can be pinned at once. */
const MAX_PINNED = 3;
const HOUR = 3_600_000;

type Filter = 'all' | 'unread' | 'groups';

const ATTACHMENT_ICONS: Record<ReturnType<typeof attachmentType>['kind'], LucideIcon> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: MicIcon,
  file: FileIcon,
};

function preview(entry: ChatListEntry, names: Names): string {
  const last = entry.last;
  if (!last) return 'Say hi';
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

function useChatIdentity(conversation: ConversationRecord) {
  const isGroup = conversation.kind === 'group';
  const contact = useContact(isGroup ? undefined : conversation.peerUserId);
  const group = useGroup(isGroup ? conversation.conversationId : undefined);
  return {
    isGroup,
    name: isGroup ? group?.name || 'Group' : contactName(contact),
    picture: isGroup ? groupPictureUri(group?.avatar) : contact?.avatarUrl,
  };
}

const BADGE_POP = {
  from: { transform: [{ scale: 0.6 }] },
  to: { transform: [{ scale: 1 }] },
};

function UnreadBadge({ count, muted }: { count: number; muted: boolean }) {
  const { moves } = useMotion();
  return (
    <Animated.View
      // A new count pops; the key restarts the animation.
      key={count}
      className={`min-w-[24px] items-center justify-center rounded-full px-2 py-[2px] ${
        muted ? 'bg-raised' : 'bg-secondary'
      }`}
      style={
        moves
          ? {
              animationName: BADGE_POP,
              animationDuration: 240,
              animationTimingFunction: CSS_POP,
            }
          : undefined
      }
    >
      <Text className={`text-xs font-bold ${muted ? 'text-muted' : 'text-on-secondary'}`}>
        {count > 99 ? '99+' : count}
      </Text>
    </Animated.View>
  );
}

interface RowActions {
  onLongPress: (entry: ChatListEntry, name: string) => void;
  onPin: (conversation: ConversationRecord) => void;
  onArchive: (conversation: ConversationRecord) => void;
}

function ChatRow({ entry, actions }: { entry: ChatListEntry; actions: RowActions }) {
  const router = useRouter();
  const { prefs } = useTheme();
  const readReceipts = useReadReceipts();
  const names = useNames();
  const { conversation, last } = entry;
  const { isGroup, name, picture } = useChatIdentity(conversation);
  const text = preview(entry, names);
  const status =
    last?.direction === 'out' && last.state && last.kind !== 'deleted'
      ? stateLabel(shownState(last.state, readReceipts), true)
      : undefined;
  const unread = conversation.unreadCount;
  const muted = isMuted(conversation);
  const pinned = conversation.pinnedAt !== null;
  const compact = prefs.density === 'compact';
  const attachmentIcon =
    last?.kind === 'attachment' ? ATTACHMENT_ICONS[attachmentType(last).kind] : undefined;
  return (
    <SwipeAction
      left={{
        icon: pinned ? PinOffIcon : PinIcon,
        onCommit: () => actions.onPin(conversation),
      }}
      right={{
        icon: conversation.archived ? ArchiveRestoreIcon : ArchiveIcon,
        onCommit: () => actions.onArchive(conversation),
      }}
    >
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
        onLongPress={() => actions.onLongPress(entry, name)}
        className={`mx-3 flex-row items-center gap-3 rounded-xl bg-background px-2 active:bg-raised ${
          compact ? 'py-2' : 'py-3'
        }`}
      >
        <Avatar url={picture} name={name} size={compact ? 44 : 54} />
        <View className="flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text numberOfLines={1} className="flex-1 text-base font-bold text-foreground">
              {name}
            </Text>
            {muted && <Icon icon={BellOffIcon} size={14} color="muted" />}
            {pinned && <Icon icon={PinIcon} size={14} color="muted" />}
            {last && (
              <Text
                className={`text-xs ${unread > 0 && !muted ? 'font-bold text-accent' : 'text-muted'}`}
              >
                {when(last.sortAt)}
              </Text>
            )}
          </View>
          <View className="flex-row items-center gap-1">
            {status && <StateTick icon={status.icon} size={16} />}
            {attachmentIcon && <Icon icon={attachmentIcon} size={14} color="muted" />}
            <Text
              numberOfLines={1}
              className={`flex-1 ${
                unread > 0 ? 'font-semibold text-foreground' : 'text-muted'
              } ${last?.kind === 'deleted' ? 'italic' : ''}`}
            >
              {text}
            </Text>
            {unread > 0 && <UnreadBadge count={unread} muted={muted} />}
          </View>
        </View>
      </Pressable>
    </SwipeAction>
  );
}

/** Pinned chats as a strip of big faces at the top: the people you talk to most, one tap away. */
function PinnedStrip({ entries }: { entries: ChatListEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel="Pinned chats"
      contentContainerClassName="gap-4 px-5 pb-1 pt-2"
    >
      {entries.map((entry) => (
        <PinnedChat key={entry.conversation.conversationId} entry={entry} />
      ))}
    </ScrollView>
  );
}

function PinnedChat({ entry }: { entry: ChatListEntry }) {
  const router = useRouter();
  const { conversation } = entry;
  const { name, picture } = useChatIdentity(conversation);
  const unread = conversation.unreadCount > 0;
  return (
    <Tap
      accessibilityLabel={`${name}, pinned${unread ? `, ${conversation.unreadCount} unread` : ''}`}
      feedback="selection"
      onPress={() =>
        router.push({
          pathname: '/chat/[conversationId]',
          params: { conversationId: conversation.conversationId },
        })
      }
      className="w-[76px] items-center gap-1"
    >
      <Avatar url={picture} name={name} size={64} ring={unread} />
      <Text numberOfLines={1} className="text-xs font-semibold text-foreground">
        {name}
      </Text>
    </Tap>
  );
}

function Empty({ archived, filter }: { archived: boolean; filter: Filter }) {
  if (archived) {
    return (
      <EmptyState
        icon={ArchiveIcon}
        title="Nothing archived"
        message="Swipe a chat left to tuck it away here."
      />
    );
  }
  if (filter === 'unread') {
    return <EmptyState icon={SparklesIcon} title="All caught up" message="No unread messages." />;
  }
  if (filter === 'groups') {
    return (
      <EmptyState
        icon={UsersRoundIcon}
        title="No groups yet"
        message="Tap the + to start one with your people."
      />
    );
  }
  return (
    <EmptyState
      icon={SparklesIcon}
      title="No chats yet"
      message="Tap the + and enter someone’s exact username. Messages are end-to-end encrypted and kept on your devices."
    />
  );
}

/** The chat list, or (with `archived`) the archived chats. */
export function ChatListScreen({ archived = false }: { archived?: boolean }) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const tabInset = useTabBarInset({ newButton: !archived });
  const { entries, loading } = useConversations();
  const [menu, setMenu] = useState<{ entry: ChatListEntry; name: string }>();
  const [muting, setMuting] = useState<ConversationRecord>();
  const [filter, setFilter] = useState<Filter>('all');

  const inFolder = ordered(entries.filter((e) => e.conversation.archived === archived));
  const shown = inFolder.filter((e) =>
    filter === 'unread'
      ? e.conversation.unreadCount > 0
      : filter === 'groups'
        ? e.conversation.kind === 'group'
        : true,
  );
  const archivedEntries = entries.filter((e) => e.conversation.archived);
  const archivedUnread = archivedEntries.reduce((n, e) => n + e.conversation.unreadCount, 0);
  const pinned = inFolder.filter((e) => e.conversation.pinnedAt !== null);
  const unreadChats = inFolder.filter((e) => e.conversation.unreadCount > 0).length;
  const pinnedCount = entries.filter((e) => e.conversation.pinnedAt !== null).length;

  function togglePin(conversation: ConversationRecord): void {
    if (!runtime) return;
    const isPinned = conversation.pinnedAt !== null;
    if (!isPinned && pinnedCount >= MAX_PINNED) {
      Alert.alert('Pin limit', `You can pin up to ${MAX_PINNED} chats. Unpin one first.`);
      return;
    }
    void runtime.engine.setPinned(conversation.conversationId, !isPinned);
  }

  function toggleArchive(conversation: ConversationRecord): void {
    void runtime?.engine.setArchived(conversation.conversationId, !conversation.archived);
  }

  const actions: SheetAction[] = [];
  if (menu && runtime) {
    const { conversation } = menu.entry;
    const { conversationId } = conversation;
    const { engine } = runtime;
    const isPinned = conversation.pinnedAt !== null;
    actions.push({
      label: isPinned ? 'Unpin' : 'Pin to top',
      icon: isPinned ? PinOffIcon : PinIcon,
      onPress: () => togglePin(conversation),
    });
    actions.push({
      label: conversation.archived ? 'Unarchive' : 'Archive',
      icon: conversation.archived ? ArchiveRestoreIcon : ArchiveIcon,
      ...(conversation.archived
        ? {}
        : { detail: 'Moves it to Archived. New messages keep it there.' }),
      onPress: () => toggleArchive(conversation),
    });
    actions.push(
      isMuted(conversation)
        ? {
            label: 'Unmute',
            icon: BellIcon,
            onPress: () => void engine.setMuted(conversationId, null),
          }
        : { label: 'Mute…', icon: BellOffIcon, onPress: () => setMuting(conversation) },
    );
    const isGroup = conversation.kind === 'group';
    actions.push({
      label: 'Delete chat',
      icon: Trash2Icon,
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

  const rowActions: RowActions = {
    onLongPress: (entry, name) => setMenu({ entry, name }),
    onPin: togglePin,
    onArchive: toggleArchive,
  };

  return (
    <View className="flex-1 bg-background">
      {!archived && (
        <TabHeader title="Chats">
          <Tap
            accessibilityLabel="Search chats"
            feedback="selection"
            onPress={() => router.push('/search')}
            className="h-11 w-11 items-center justify-center rounded-full bg-raised"
          >
            <Icon icon={SearchIcon} size={22} />
          </Tap>
        </TabHeader>
      )}
      <View className={`gap-2 px-4 ${archived ? 'pt-2' : ''}`}>
        <OfflineBanner />
        {!archived && <NotificationPrompt />}
      </View>
      {loading ? (
        <SkeletonRows />
      ) : (
        <FlashList
          data={shown}
          keyExtractor={(entry) => entry.conversation.conversationId}
          renderItem={({ item }) => <ChatRow entry={item} actions={rowActions} />}
          ListHeaderComponent={
            archived ? null : (
              <View className="gap-3 pb-2">
                <PinnedStrip entries={pinned} />
                {inFolder.length > 0 && (
                  <ChipRow label="Filter chats">
                    <Chip
                      label="All"
                      selected={filter === 'all'}
                      onPress={() => setFilter('all')}
                    />
                    <Chip
                      label="Unread"
                      selected={filter === 'unread'}
                      count={unreadChats}
                      onPress={() => setFilter('unread')}
                    />
                    <Chip
                      label="Groups"
                      selected={filter === 'groups'}
                      onPress={() => setFilter('groups')}
                    />
                  </ChipRow>
                )}
                {archivedEntries.length > 0 && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Archived chats, ${archivedEntries.length}${archivedUnread ? `, ${archivedUnread} unread` : ''}`}
                    onPress={() => router.push('/archived')}
                    className="mx-3 min-h-[48px] flex-row items-center gap-3 rounded-lg px-2 py-2 active:bg-raised"
                  >
                    <View className="h-9 w-9 items-center justify-center rounded-md bg-raised">
                      <Icon icon={ArchiveIcon} size={18} color="muted" />
                    </View>
                    <Text className="flex-1 font-bold text-foreground">
                      Archived ({archivedEntries.length})
                    </Text>
                    {archivedUnread > 0 && (
                      <Text className="font-semibold text-accent">{archivedUnread} unread</Text>
                    )}
                    <Icon icon={ChevronRightIcon} size={18} color="muted" />
                  </Pressable>
                )}
              </View>
            )
          }
          ListEmptyComponent={<Empty archived={archived} filter={filter} />}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: tabInset }}
        />
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
