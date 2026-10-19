import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { OfflineBanner } from '@/components/offline-banner';
import { useBlocks, useIsBlocked } from '@/engine/blocks';
import { contactName } from '@/engine/contacts';
import {
  useChatRuntime,
  useConnectionStatus,
  useContact,
  useConversation,
  usePresence,
  useQuoted,
  useReadReceipts,
  takeJump,
} from '@/engine/hooks';
import { previewText, shownState, stateLabel } from '@/engine/labels';
import { watchPresence } from '@/engine/runtime';
import { timeLabel, type TimelineItem } from '@/engine/timeline';
import { usePalette } from '@/theme/theme-root';
import {
  canReact,
  MessageActionError,
  summarizeReactions,
  type ConversationRecord,
  type MessageRecord,
} from '@pingdost/message-engine';

/** Longest message; far inside one envelope even in 4-byte UTF-8. */
const MAX_TEXT = 4_000;
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function failed(action: string, error: unknown): void {
  const reason =
    error instanceof MessageActionError && error.code === 'not_allowed'
      ? 'It can no longer be changed (only your own messages, within 24 hours of sending).'
      : 'Please try again.';
  Alert.alert(`Could not ${action}`, reason);
}

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

/** The message a reply quotes, or why it cannot be shown. */
function Quote({
  replyTo,
  conversationId,
  loaded,
  names,
  outgoing,
  onPress,
}: {
  replyTo: string;
  conversationId: string;
  loaded: ReadonlyMap<string, MessageRecord>;
  names: (message: MessageRecord) => string;
  outgoing: boolean;
  onPress: (messageId: string) => void;
}) {
  const quoted = useQuoted(replyTo, conversationId, loaded);
  const text = quoted ? previewText(quoted) : 'Original message not available';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={quoted ? `Reply to ${names(quoted)}: ${text}` : text}
      disabled={!quoted}
      onPress={() => quoted && onPress(quoted.messageId)}
      className={`mb-1 rounded-md border-l-4 px-2 py-1 ${
        outgoing ? 'border-on-primary/60 bg-on-primary/10' : 'border-primary bg-primary/10'
      }`}
    >
      {quoted && (
        <Text
          numberOfLines={1}
          className={`font-semibold ${outgoing ? 'text-on-primary' : 'text-primary'}`}
        >
          {names(quoted)}
        </Text>
      )}
      <Text
        numberOfLines={2}
        className={`${outgoing ? 'text-on-primary' : 'text-foreground'} ${quoted ? '' : 'italic'}`}
      >
        {text}
      </Text>
    </Pressable>
  );
}

function Reactions({
  message,
  selfUserId,
  onToggle,
}: {
  message: MessageRecord;
  selfUserId: string;
  onToggle: (emoji: string, mine: boolean) => void;
}) {
  const summary = summarizeReactions(message.reactions, selfUserId);
  if (summary.length === 0) return null;
  return (
    <View
      className={`-mt-1 flex-row flex-wrap gap-1 ${message.direction === 'out' ? 'justify-end' : ''}`}
    >
      {summary.map((reaction) => (
        <Pressable
          key={reaction.emoji}
          accessibilityRole="button"
          accessibilityLabel={`${reaction.emoji} ${reaction.count}${reaction.mine ? ', yours. Double tap to remove' : ''}`}
          onPress={() => onToggle(reaction.emoji, reaction.mine)}
          className={`min-h-[32px] flex-row items-center gap-1 rounded-full border px-2 ${
            reaction.mine ? 'border-primary bg-primary/15' : 'border-border bg-surface'
          }`}
        >
          <Text className="text-base">{reaction.emoji}</Text>
          {reaction.count > 1 && <Text className="text-muted">{reaction.count}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

interface BubbleProps {
  message: MessageRecord;
  online: boolean;
  readReceipts: boolean;
  peerUserId: string | undefined;
  selfUserId: string;
  loaded: ReadonlyMap<string, MessageRecord>;
  names: (message: MessageRecord) => string;
  highlighted: boolean;
  onLongPress: (message: MessageRecord) => void;
  onQuotePress: (messageId: string) => void;
  onReact: (message: MessageRecord, emoji: string | null) => void;
}

function Bubble(props: BubbleProps) {
  const { message, online, readReceipts, peerUserId, highlighted } = props;
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
  const deleted = message.kind === 'deleted';
  const status =
    outgoing && message.state && !deleted
      ? stateLabel(shownState(message.state, readReceipts), online)
      : undefined;
  const body =
    message.kind === 'unsupported'
      ? 'This message needs a newer version of PingDost. Update the app to read it.'
      : deleted
        ? outgoing
          ? 'You deleted this message'
          : 'This message was deleted'
        : message.body;
  const retry =
    message.state === 'failed' && runtime && !deleted
      ? () => void runtime.engine.retry(message.messageId)
      : undefined;
  const edited = message.editedAt !== null && !deleted;

  return (
    <View className={`my-1 max-w-[82%] gap-1 px-3 ${outgoing ? 'self-end' : 'self-start'}`}>
      <Pressable
        accessibilityRole="text"
        accessibilityLabel={`${outgoing ? 'You' : 'They'}: ${body}. ${timeLabel(message.sortAt)}${edited ? ', edited' : ''}${status ? `. ${status.long}` : ''}`}
        accessibilityHint={retry ? 'Double tap to send it again' : 'Long press for actions'}
        onLongPress={() => props.onLongPress(message)}
        onPress={retry}
        className={`rounded-lg px-3 py-2 ${
          deleted
            ? 'border border-dashed border-border'
            : outgoing
              ? 'bg-primary'
              : 'border border-border bg-surface'
        } ${highlighted ? 'opacity-70' : ''}`}
      >
        {message.replyTo && !deleted && (
          <Quote
            replyTo={message.replyTo}
            conversationId={message.conversationId}
            loaded={props.loaded}
            names={props.names}
            outgoing={outgoing}
            onPress={props.onQuotePress}
          />
        )}
        <Text
          selectable={false}
          className={`text-base ${outgoing && !deleted ? 'text-on-primary' : 'text-foreground'} ${
            message.kind === 'unsupported' || deleted ? 'italic' : ''
          } ${deleted ? 'text-muted' : ''}`}
        >
          {deleted ? `🚫 ${body}` : body}
        </Text>
      </Pressable>
      {!deleted && (
        <Reactions
          message={message}
          selfUserId={props.selfUserId}
          onToggle={(emoji, mine) => props.onReact(message, mine ? null : emoji)}
        />
      )}
      <View className={`flex-row gap-1 ${outgoing ? 'justify-end' : 'justify-start'}`}>
        <Text className="text-muted">
          {timeLabel(message.sortAt)}
          {edited ? ' · edited' : ''}
        </Text>
        {status && (
          <Text className={status.tone === 'danger' ? 'text-danger' : 'text-muted'}>
            · {status.glyph} {status.short}
          </Text>
        )}
      </View>
    </View>
  );
}

function Composer({
  conversationId,
  replyTo,
  editing,
  names,
  onDone,
}: {
  conversationId: string;
  replyTo: MessageRecord | undefined;
  editing: MessageRecord | undefined;
  names: (message: MessageRecord) => string;
  onDone: () => void;
}) {
  const runtime = useChatRuntime();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const trimmed = text.trim();

  useEffect(() => {
    if (editing) setText(editing.body);
  }, [editing]);

  function send() {
    if (!runtime || trimmed === '') return;
    setText('');
    onDone();
    void runtime.engine.setTyping(conversationId, false);
    if (editing) {
      if (trimmed !== editing.body.trim()) {
        runtime.engine.editMessage(editing.messageId, trimmed).catch((error: unknown) => {
          failed('edit the message', error);
        });
      }
      return;
    }
    void runtime.engine.sendText(conversationId, trimmed, {
      ...(replyTo ? { replyTo: replyTo.messageId } : {}),
    });
  }

  const context = editing ?? replyTo;
  return (
    <View
      className="border-t border-border bg-background px-3 pt-2"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      {context && (
        <View className="mb-2 flex-row items-center gap-2 rounded-md border-l-4 border-primary bg-surface px-3 py-2">
          <View className="flex-1">
            <Text className="font-semibold text-primary">
              {editing ? 'Editing message' : `Replying to ${names(context)}`}
            </Text>
            <Text numberOfLines={editing ? 2 : 1} className="text-muted">
              {editing
                ? 'Shown as “edited” on every device. The earlier text is not kept.'
                : previewText(context)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Cancel editing' : 'Cancel reply'}
            onPress={() => {
              if (editing) setText('');
              onDone();
            }}
            className="min-h-[44px] min-w-[44px] items-center justify-center"
          >
            <Text className="text-xl text-muted">✕</Text>
          </Pressable>
        </View>
      )}
      <View className="flex-row items-end gap-2">
        <TextInput
          accessibilityLabel={editing ? 'Edited message' : 'Message'}
          placeholder="Message"
          placeholderTextColor={palette.muted}
          value={text}
          maxLength={MAX_TEXT}
          multiline
          autoFocus={editing !== undefined}
          onChangeText={(next) => {
            setText(next);
            if (runtime && !editing)
              void runtime.engine.setTyping(conversationId, next.trim() !== '');
          }}
          onBlur={() => runtime && void runtime.engine.setTyping(conversationId, false)}
          className="max-h-[140px] min-h-[44px] flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-base text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Save' : 'Send'}
          accessibilityState={{ disabled: trimmed === '' }}
          disabled={trimmed === '' || !runtime}
          onPress={send}
          className={`min-h-[44px] justify-center rounded-lg bg-primary px-4 active:opacity-80 ${
            trimmed === '' ? 'opacity-50' : ''
          }`}
        >
          <Text className="text-base font-semibold text-on-primary">
            {editing ? 'Save' : 'Send'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function BlockedNotice({ peerUserId, name }: { peerUserId: string; name: string }) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  return (
    <View
      className="gap-2 border-t border-border bg-background px-4 pt-3"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
      <Text className="text-center text-muted">
        You blocked {name}. You can&apos;t message each other until you unblock them.
      </Text>
      <Button
        label="Unblock"
        variant="secondary"
        loading={busy}
        onPress={() => {
          setBusy(true);
          useBlocks
            .getState()
            .unblock(peerUserId)
            .catch(() => Alert.alert('Could not unblock', 'Check your connection and try again.'))
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}

export function ChatScreen({
  conversationId,
  focusMessageId,
}: {
  conversationId: string;
  /** A search result to scroll to. */
  focusMessageId?: string | undefined;
}) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const status = useConnectionStatus();
  const readReceipts = useReadReceipts();
  const headerHeight = useHeaderHeight();
  const [conversation, setConversation] = useState<ConversationRecord>();
  const { items, loaded, loadOlder, loadUntil, typing } = useConversation(conversationId);
  const focused = useRef(false);
  const list = useRef<FlashListRef<TimelineItem>>(null);
  const peerUserId = conversation?.peerUserId;
  const contact = useContact(peerUserId);
  const blocked = useIsBlocked(peerUserId);
  const name = contactName(contact);
  const [selected, setSelected] = useState<MessageRecord>();
  const [deleting, setDeleting] = useState<MessageRecord>();
  const [replyTo, setReplyTo] = useState<MessageRecord>();
  const [editing, setEditing] = useState<MessageRecord>();
  const [highlight, setHighlight] = useState<string>();
  const selfUserId = runtime?.userId ?? '';

  const names = useCallback(
    (message: MessageRecord) => (message.senderUserId === selfUserId ? 'You' : name),
    [selfUserId, name],
  );

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

  // Reading the conversation clears its unread count (and sends read receipts if on).
  useEffect(() => {
    if (focused.current && runtime) void runtime.engine.markRead(conversationId);
  }, [runtime, conversationId, items.length]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const jumpTo = useCallback(
    async (messageId: string) => {
      if (!(await loadUntil(messageId))) return;
      // Wait a frame so the list has the loaded page.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const index = itemsRef.current.findIndex((item) => item.key === messageId);
      if (index < 0) return;
      void list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      setHighlight(messageId);
      setTimeout(
        () => setHighlight((current) => (current === messageId ? undefined : current)),
        1_500,
      );
    },
    [loadUntil],
  );

  // A search result: jump once, after the first page arrived.
  const jumped = useRef<string>(undefined);
  useEffect(() => {
    if (!focusMessageId || items.length === 0 || jumped.current === focusMessageId) return;
    jumped.current = focusMessageId;
    void jumpTo(focusMessageId);
  }, [focusMessageId, items.length, jumpTo]);
  // A result picked in this chat's own search, on coming back.
  useFocusEffect(
    useCallback(() => {
      const target = takeJump(conversationId);
      if (target) void jumpTo(target);
    }, [conversationId, jumpTo]),
  );

  const react = useCallback(
    (message: MessageRecord, emoji: string | null) => {
      runtime?.engine.react(message.messageId, emoji).catch((error: unknown) => {
        failed('react', error);
      });
    },
    [runtime],
  );

  const renderItem = useCallback(
    ({ item }: { item: TimelineItem }) =>
      item.type === 'day' ? (
        <Text className="my-3 self-center rounded-full bg-surface px-3 py-1 text-muted">
          {item.label}
        </Text>
      ) : (
        <Bubble
          message={item.message}
          online={status === 'online'}
          readReceipts={readReceipts}
          peerUserId={peerUserId}
          selfUserId={selfUserId}
          loaded={loaded}
          names={names}
          highlighted={highlight === item.message.messageId}
          onLongPress={setSelected}
          onQuotePress={(messageId) => void jumpTo(messageId)}
          onReact={react}
        />
      ),
    [status, readReceipts, peerUserId, selfUserId, loaded, names, highlight, jumpTo, react],
  );

  const actions: SheetAction[] = [];
  if (selected && runtime) {
    const message = selected;
    if (canReact(message) && !blocked) {
      actions.push({ label: 'Reply', onPress: () => setReplyTo(message) });
    }
    if (runtime.engine.canEdit(message)) {
      actions.push({
        label: 'Edit',
        onPress: () => {
          setReplyTo(undefined);
          setEditing(message);
        },
      });
    }
    if (message.direction === 'out' && message.kind !== 'deleted') {
      actions.push({
        label: 'Message info',
        onPress: () =>
          router.push({
            pathname: '/message-info/[messageId]',
            params: { messageId: message.messageId },
          }),
      });
    }
    actions.push({ label: 'Delete…', destructive: true, onPress: () => setDeleting(message) });
  }
  const mine = selected?.reactions.find((r) => r.userId === selfUserId)?.emoji ?? null;

  const deleteActions: SheetAction[] = [];
  if (deleting && runtime) {
    const message = deleting;
    deleteActions.push({
      label: 'Delete for me',
      detail: `Removes it from this phone only. ${message.direction === 'out' ? name : 'The sender'} keeps their copy.`,
      destructive: true,
      onPress: () => void runtime.engine.deleteForMe([message.messageId]),
    });
    if (runtime.engine.canDeleteForEveryone(message)) {
      deleteActions.push({
        label: 'Delete for everyone',
        detail:
          "Asks every copy to be removed. It can't erase screenshots, exports, notifications or copies already saved elsewhere.",
        destructive: true,
        onPress: () => {
          runtime.engine.deleteForEveryone(message.messageId).catch((error: unknown) => {
            failed('delete the message for everyone', error);
          });
        },
      });
    }
  }

  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
      className="flex-1 bg-background"
    >
      <Stack.Screen
        options={{
          headerTitle: () => <HeaderTitle peerUserId={peerUserId} />,
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Search this chat"
              onPress={() => router.push({ pathname: '/search', params: { conversationId } })}
              className="min-h-[44px] justify-center px-2 active:opacity-70"
            >
              <Text className="text-base text-primary">Search</Text>
            </Pressable>
          ),
        }}
      />
      <View className="px-4">
        <OfflineBanner />
      </View>
      <FlashList
        ref={list}
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
            Messages with {name} are end-to-end encrypted. No one else, not even PingDost, can read
            them.
          </Text>
        }
      />
      {typing && !blocked && (
        <Text accessibilityLiveRegion="polite" className="px-4 pb-1 text-muted">
          {name} is typing…
        </Text>
      )}
      {blocked && peerUserId ? (
        <BlockedNotice peerUserId={peerUserId} name={name} />
      ) : (
        <Composer
          conversationId={conversationId}
          replyTo={replyTo}
          editing={editing}
          names={names}
          onDone={() => {
            setReplyTo(undefined);
            setEditing(undefined);
          }}
        />
      )}

      <ActionSheet
        visible={selected !== undefined}
        onClose={() => setSelected(undefined)}
        {...(selected ? { title: previewText(selected) } : {})}
        header={
          selected && canReact(selected) && !blocked ? (
            <View className="flex-row justify-around px-2 pb-2">
              {QUICK_REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={mine === emoji ? `Remove ${emoji}` : `React ${emoji}`}
                  onPress={() => {
                    const message = selected;
                    setSelected(undefined);
                    react(message, mine === emoji ? null : emoji);
                  }}
                  className={`min-h-[48px] min-w-[48px] items-center justify-center rounded-full ${
                    mine === emoji ? 'bg-primary/20' : ''
                  }`}
                >
                  <Text className="text-2xl">{emoji}</Text>
                </Pressable>
              ))}
            </View>
          ) : undefined
        }
        actions={actions}
      />
      <ActionSheet
        visible={deleting !== undefined}
        onClose={() => setDeleting(undefined)}
        title="Delete this message?"
        actions={deleteActions}
      />
    </KeyboardAvoidingView>
  );
}
