import { FlashList } from '@shopify/flash-list';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { OfflineBanner } from '@/components/offline-banner';
import { contactName } from '@/engine/contacts';
import {
  useChatRuntime,
  useConnectionStatus,
  useContact,
  useConversation,
  usePresence,
} from '@/engine/hooks';
import { stateLabel } from '@/engine/labels';
import { watchPresence } from '@/engine/runtime';
import { timeLabel, type TimelineItem } from '@/engine/timeline';
import { usePalette } from '@/theme/theme-root';
import type { ConversationRecord, MessageRecord } from '@pingdost/message-engine';

/** Longest message; far inside one envelope even in 4-byte UTF-8. */
const MAX_TEXT = 4_000;

function HeaderTitle({ peerUserId }: { peerUserId: string | undefined }) {
  const router = useRouter();
  const contact = useContact(peerUserId);
  const online = usePresence(peerUserId);
  const runtime = useChatRuntime();
  const [verified, setVerified] = useState(false);
  const name = contactName(contact);

  useFocusEffect(
    useCallback(() => {
      if (!runtime || !peerUserId) return;
      void runtime.engine.contact(peerUserId).then((info) => setVerified(info.verified));
    }, [runtime, peerUserId]),
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${verified ? ', verified' : ''}. Contact info`}
      disabled={!peerUserId}
      onPress={() =>
        peerUserId && router.push({ pathname: '/contact/[userId]', params: { userId: peerUserId } })
      }
      className="flex-row items-center gap-3 active:opacity-70"
    >
      <Avatar url={contact?.avatarUrl} name={name} size={36} />
      <View>
        <Text numberOfLines={1} className="text-base font-semibold text-foreground">
          {name}
          {verified ? '  ✓' : ''}
        </Text>
        {online && <Text className="text-muted">online</Text>}
      </View>
    </Pressable>
  );
}

function Bubble({
  message,
  online,
  peerUserId,
}: {
  message: MessageRecord;
  online: boolean;
  peerUserId: string | undefined;
}) {
  const router = useRouter();
  const runtime = useChatRuntime();

  if (message.kind === 'system') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          peerUserId &&
          router.push({ pathname: '/contact/[userId]', params: { userId: peerUserId } })
        }
        className="mx-6 my-2 items-center rounded-md border border-border px-3 py-2"
      >
        <Text className="text-center text-muted">
          Your safety number with this contact changed. Tap to verify it again.
        </Text>
      </Pressable>
    );
  }

  const outgoing = message.direction === 'out';
  const status = outgoing && message.state ? stateLabel(message.state, online) : undefined;
  const body =
    message.kind === 'unsupported'
      ? 'This message needs a newer version of PingDost. Update the app to read it.'
      : message.body;
  const openInfo = () =>
    router.push({
      pathname: '/message-info/[messageId]',
      params: { messageId: message.messageId },
    });
  const retry =
    message.state === 'failed' && runtime
      ? () => void runtime.engine.retry(message.messageId)
      : undefined;

  return (
    <View className={`my-1 max-w-[82%] px-3 ${outgoing ? 'self-end' : 'self-start'}`}>
      <Pressable
        accessibilityRole="text"
        accessibilityLabel={`${outgoing ? 'You' : 'They'}: ${body}. ${timeLabel(message.sortAt)}${status ? `. ${status.long}` : ''}`}
        accessibilityHint={retry ? 'Double tap to send it again' : 'Long press for message info'}
        onLongPress={openInfo}
        onPress={retry}
        className={`rounded-lg px-3 py-2 ${outgoing ? 'bg-primary' : 'border border-border bg-surface'}`}
      >
        <Text
          selectable={false}
          className={`text-base ${outgoing ? 'text-on-primary' : 'text-foreground'} ${
            message.kind === 'unsupported' ? 'italic' : ''
          }`}
        >
          {body}
        </Text>
      </Pressable>
      <View className={`mt-1 flex-row gap-1 ${outgoing ? 'justify-end' : 'justify-start'}`}>
        <Text className="text-muted">{timeLabel(message.sortAt)}</Text>
        {status && (
          <Text className={status.tone === 'danger' ? 'text-danger' : 'text-muted'}>
            · {status.glyph} {status.short}
          </Text>
        )}
      </View>
    </View>
  );
}

function Composer({ conversationId }: { conversationId: string }) {
  const runtime = useChatRuntime();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const trimmed = text.trim();

  function send() {
    if (!runtime || trimmed === '') return;
    setText('');
    void runtime.engine.setTyping(conversationId, false);
    void runtime.engine.sendText(conversationId, trimmed);
  }

  return (
    <View
      className="flex-row items-end gap-2 border-t border-border bg-background px-3 pt-2"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      <TextInput
        accessibilityLabel="Message"
        placeholder="Message"
        placeholderTextColor={palette.muted}
        value={text}
        maxLength={MAX_TEXT}
        multiline
        onChangeText={(next) => {
          setText(next);
          if (runtime) void runtime.engine.setTyping(conversationId, next.trim() !== '');
        }}
        onBlur={() => runtime && void runtime.engine.setTyping(conversationId, false)}
        className="max-h-[140px] min-h-[44px] flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-base text-foreground"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        accessibilityState={{ disabled: trimmed === '' }}
        disabled={trimmed === '' || !runtime}
        onPress={send}
        className={`min-h-[44px] justify-center rounded-lg bg-primary px-4 active:opacity-80 ${
          trimmed === '' ? 'opacity-50' : ''
        }`}
      >
        <Text className="text-base font-semibold text-on-primary">Send</Text>
      </Pressable>
    </View>
  );
}

export function ChatScreen({ conversationId }: { conversationId: string }) {
  const runtime = useChatRuntime();
  const status = useConnectionStatus();
  const headerHeight = useHeaderHeight();
  const [conversation, setConversation] = useState<ConversationRecord>();
  const { items, loadOlder, typing } = useConversation(conversationId);
  const focused = useRef(false);
  const peerUserId = conversation?.peerUserId;
  const contact = useContact(peerUserId);

  useEffect(() => {
    if (!runtime) return;
    void runtime.engine.getConversation(conversationId).then(setConversation);
  }, [runtime, conversationId]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      if (peerUserId) watchPresence([peerUserId]);
      return () => {
        focused.current = false;
        watchPresence([]);
        if (runtime) void runtime.engine.setTyping(conversationId, false);
      };
    }, [runtime, conversationId, peerUserId]),
  );

  // Reading the conversation clears its unread count, including messages arriving now.
  useEffect(() => {
    if (focused.current && runtime) void runtime.engine.markRead(conversationId);
  }, [runtime, conversationId, items.length]);

  const renderItem = useCallback(
    ({ item }: { item: TimelineItem }) =>
      item.type === 'day' ? (
        <Text className="my-3 self-center rounded-full bg-surface px-3 py-1 text-muted">
          {item.label}
        </Text>
      ) : (
        <Bubble message={item.message} online={status === 'online'} peerUserId={peerUserId} />
      ),
    [status, peerUserId],
  );

  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
      className="flex-1 bg-background"
    >
      <Stack.Screen options={{ headerTitle: () => <HeaderTitle peerUserId={peerUserId} /> }} />
      <View className="px-4">
        <OfflineBanner />
      </View>
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        renderItem={renderItem}
        maintainVisibleContentPosition={{
          startRenderingFromBottom: true,
          autoscrollToBottomThreshold: 0.2,
        }}
        onStartReached={() => void loadOlder()}
        onStartReachedThreshold={0.3}
        contentContainerStyle={{ paddingVertical: 8 }}
        ListEmptyComponent={
          <Text className="mx-6 my-8 text-center text-muted">
            Messages with {contactName(contact)} are end-to-end encrypted. No one else, not even
            PingDost, can read them.
          </Text>
        }
      />
      {typing && (
        <Text accessibilityLiveRegion="polite" className="px-4 pb-1 text-muted">
          {contactName(contact)} is typing…
        </Text>
      )}
      <Composer conversationId={conversationId} />
    </KeyboardAvoidingView>
  );
}
