// "Play with friends" from a game screen (Phase 43): pick the chat to play in (a friend's chat or
// a group), then the invitation screen opens with this game chosen. Games live in chats.
import { router } from 'expo-router';
import { FlatList, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { EmptyState } from '@/components/feedback';
import { MessageCircleIcon } from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { useGroup, useNames } from '@/engine/groups';
import { useConversations } from '@/engine/hooks';
import { catalogEntry, type GameId } from '@pingdost/games';
import type { ConversationRecord } from '@pingdost/message-engine';

function ChatRow({
  conversation,
  onPick,
}: {
  conversation: ConversationRecord;
  onPick: () => void;
}) {
  const names = useNames();
  const group = useGroup(conversation.kind === 'group' ? conversation.conversationId : undefined);
  const name =
    group?.name ?? (conversation.peerUserId ? names.name(conversation.peerUserId) : 'Chat');
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`Play in ${name}`}
      feedback="selection"
      onPress={onPick}
      className="flex-row items-center gap-3 px-5 py-3"
    >
      <Avatar url={null} name={name} size={44} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-bold text-foreground">
          {name}
        </Text>
        <Text className="text-sm text-muted">
          {conversation.kind === 'group' ? 'Group' : 'Chat'}
        </Text>
      </View>
    </Tap>
  );
}

export function PickChatScreen({ game }: { game: GameId }) {
  const { entries } = useConversations();
  const chats = entries
    .map((e) => e.conversation)
    // A game for four needs a group.
    .filter(
      (c) =>
        !c.archived && (c.kind === 'group' || (c.peerUserId && catalogEntry(game).minPlayers <= 2)),
    );
  if (chats.length === 0) {
    return (
      <View className="flex-1 bg-background">
        <EmptyState
          icon={MessageCircleIcon}
          title="No chats yet"
          message="Add a friend to your circle and start a chat, then invite them to a game."
        />
      </View>
    );
  }
  return (
    <FlatList
      className="flex-1 bg-background"
      data={chats}
      keyExtractor={(c) => c.conversationId}
      ListHeaderComponent={
        <Text className="px-5 pb-2 pt-4 text-sm text-muted">
          Where should the {catalogEntry(game).name} invitation go?
        </Text>
      }
      renderItem={({ item }) => (
        <ChatRow
          conversation={item}
          onPick={() =>
            router.replace({
              pathname: '/game/start',
              params: { conversationId: item.conversationId, game },
            })
          }
        />
      )}
    />
  );
}
