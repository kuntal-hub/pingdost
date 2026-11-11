// Forward to (Phase 39, ADR 0043): up to five chats at once, recent chats first, then circle
// members without a chat; search by name. Text goes as it is; a file goes from this phone's
// encrypted copy as a new attachment, and files not on this phone are skipped with a notice.
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { forwardFile, hasLocalCopy } from '@/attachments/forward';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { CheckMark } from '@/components/controls';
import { Icon, SearchIcon, SendIcon, XIcon } from '@/components/icon';
import { Notice } from '@/components/notice';
import { Tap } from '@/components/tap';
import { Text, TextInput } from '@/components/text';
import { useCircle } from '@/engine/circle';
import { contactName, loadContact, useContacts } from '@/engine/contacts';
import { groupPictureUri } from '@/engine/groups';
import { useChatRuntime, useConversations } from '@/engine/hooks';
import type { ChatRuntime } from '@/engine/runtime';
import { haptic } from '@/theme/motion';
import {
  forwardable,
  forwardNotice,
  forwardTargets,
  MAX_FORWARD_TARGETS,
  pickTarget,
  type ForwardTarget,
} from '@pingdost/chat-core';
import type { GroupRecord, MessageRecord } from '@pingdost/message-engine';

interface Shown extends ForwardTarget {
  avatarUrl: string | null;
}

/** The notice the chat shows after a forward (read once). */
let lastNotice: string | undefined;
export function takeForwardNotice(): string | undefined {
  const notice = lastNotice;
  lastNotice = undefined;
  return notice;
}

async function forwardAll(
  runtime: ChatRuntime,
  messages: readonly MessageRecord[],
  targets: readonly ForwardTarget[],
): Promise<{ sent: number; missing: number; failed: number }> {
  const conversationIds: string[] = [];
  for (const target of targets) {
    if (target.conversationId) conversationIds.push(target.conversationId);
    else if (target.userId) {
      const opened = await runtime.engine.openDirectConversation(target.userId);
      conversationIds.push(opened.conversationId);
    }
  }
  const result = { sent: 0, missing: 0, failed: 0 };
  for (const message of messages) {
    try {
      if (message.kind === 'text') {
        await runtime.engine.forwardText(message.messageId, conversationIds);
      } else if (await hasLocalCopy(message)) {
        await forwardFile(message, conversationIds, message.senderUserId !== runtime.userId);
      } else {
        result.missing++;
        continue;
      }
      result.sent++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

function TargetRow({
  target,
  picked,
  onToggle,
}: {
  target: Shown;
  picked: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: picked }}
      accessibilityLabel={target.kind === 'group' ? `Group ${target.name}` : target.name}
      onPress={onToggle}
      className="min-h-[60px] flex-row items-center gap-3 px-4 py-2 active:bg-raised"
    >
      <Avatar url={target.avatarUrl} name={target.name} size={40} />
      <View className="flex-1">
        <Text numberOfLines={1} className="text-base font-bold text-foreground">
          {target.name}
        </Text>
        <Text numberOfLines={1} className="text-muted">
          {target.kind === 'group'
            ? 'Group'
            : target.username && !target.name.startsWith('@')
              ? `@${target.username}`
              : ''}
        </Text>
      </View>
      <CheckMark checked={picked} />
    </Pressable>
  );
}

export function ForwardScreen({ messageIds }: { messageIds: string[] }) {
  const router = useRouter();
  const runtime = useChatRuntime();
  const insets = useSafeAreaInsets();
  const { entries } = useConversations();
  const contacts = useContacts((state) => state.byId);
  const circle = useCircle((state) => state.members);
  const circleLoaded = useCircle((state) => state.loaded);
  const [groups, setGroups] = useState<Record<string, GroupRecord>>({});
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useCircle
      .getState()
      .load()
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    void Promise.all(messageIds.map((id) => runtime.engine.getMessage(id))).then((found) => {
      if (!live) return;
      setMessages(
        found
          .filter((m): m is MessageRecord => m !== undefined && forwardable(m))
          .sort((a, b) => a.sortAt - b.sortAt),
      );
    });
    return () => {
      live = false;
    };
  }, [runtime, messageIds]);

  // Names for the chats listed (a profile not cached yet is fetched once).
  useEffect(() => {
    for (const { conversation } of entries) {
      if (conversation.kind === 'direct') void loadContact(conversation.peerUserId);
    }
  }, [entries]);

  const groupIds = useMemo(
    () =>
      entries
        .filter((e) => e.conversation.kind === 'group')
        .map((e) => e.conversation.conversationId),
    [entries],
  );
  useEffect(() => {
    if (!runtime) return;
    let live = true;
    void Promise.all(groupIds.map((id) => runtime.engine.getGroup(id))).then((found) => {
      if (!live) return;
      setGroups(
        Object.fromEntries(found.filter((g) => g !== undefined).map((g) => [g.groupId, g])),
      );
    });
    return () => {
      live = false;
    };
  }, [runtime, groupIds]);

  const members = useMemo(() => new Set(circle.map((m) => m.userId)), [circle]);
  const all = useMemo(() => {
    const chats: Shown[] = [];
    for (const { conversation } of entries) {
      if (conversation.kind === 'group') {
        const group = groups[conversation.conversationId];
        if (!group || group.left) continue;
        chats.push({
          key: conversation.conversationId,
          kind: 'group',
          conversationId: conversation.conversationId,
          userId: null,
          name: group.name || 'Group',
          username: null,
          updatedAt: conversation.updatedAt,
          avatarUrl: groupPictureUri(group.avatar),
        });
      } else {
        // One to one only within the circle (Phase 37).
        if (circleLoaded && !members.has(conversation.peerUserId)) continue;
        const contact = contacts[conversation.peerUserId];
        chats.push({
          key: conversation.conversationId,
          kind: 'direct',
          conversationId: conversation.conversationId,
          userId: conversation.peerUserId,
          name: contactName(contact),
          username: contact?.username ?? null,
          updatedAt: conversation.updatedAt,
          avatarUrl: contact?.avatarUrl ?? null,
        });
      }
    }
    const people: Shown[] = circle.map((person) => ({
      key: `user:${person.userId}`,
      kind: 'direct',
      conversationId: null,
      userId: person.userId,
      name: person.displayName || (person.username ? `@${person.username}` : 'PingDost user'),
      username: person.username,
      updatedAt: 0,
      avatarUrl: person.avatarUrl,
    }));
    return { chats, people };
  }, [entries, groups, contacts, circle, circleLoaded, members]);

  const shown = useMemo(
    () => forwardTargets(all.chats, all.people, query) as Shown[],
    [all, query],
  );
  const byKey = useMemo(() => new Map([...all.chats, ...all.people].map((t) => [t.key, t])), [all]);
  const pickedTargets = picked.map((key) => byKey.get(key)).filter((t) => t !== undefined);

  function toggle(key: string) {
    const next = pickTarget(picked, key);
    if (next === false) {
      haptic('error');
      setError(`You can forward to up to ${MAX_FORWARD_TARGETS} chats at once.`);
      return;
    }
    setError(undefined);
    setPicked(next);
  }

  async function send() {
    if (!runtime || pickedTargets.length === 0 || messages.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await forwardAll(runtime, messages, pickedTargets);
      if (result.sent === 0) {
        setError(forwardNotice(result));
        setBusy(false);
        return;
      }
      haptic('success');
      lastNotice = forwardNotice(result);
      router.back();
    } catch {
      setError('The messages could not be forwarded. Try again.');
      setBusy(false);
    }
  }

  const files = messages.filter((m) => m.kind === 'attachment').length;

  return (
    <View className="flex-1 bg-background">
      <View className="gap-3 px-4 pb-2 pt-3">
        {pickedTargets.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
            accessibilityLabel={`${pickedTargets.length} picked`}
          >
            {pickedTargets.map((target) => (
              <Tap
                key={target.key}
                accessibilityLabel={`Remove ${target.name}`}
                feedback="selection"
                onPress={() => toggle(target.key)}
                className="min-h-[40px] flex-row items-center gap-2 rounded-full bg-accent/15 pl-1 pr-3"
              >
                <Avatar url={target.avatarUrl} name={target.name} size={30} />
                <Text numberOfLines={1} className="max-w-[140px] font-semibold text-foreground">
                  {target.name}
                </Text>
                <Icon icon={XIcon} size={16} color="accent" />
              </Tap>
            ))}
          </ScrollView>
        )}
        <View className="h-[48px] flex-row items-center gap-2 rounded-xl bg-surface px-4">
          <Icon icon={SearchIcon} size={18} color="muted" />
          <TextInput
            accessibilityLabel="Search chats"
            placeholder="Search chats and your circle"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            className="flex-1 text-base text-foreground"
          />
        </View>
        <Text className="text-muted">
          {messages.length === 1 ? '1 message' : `${messages.length} messages`}
          {files > 0 ? ` (${files === 1 ? '1 file' : `${files} files`})` : ''} · up to{' '}
          {MAX_FORWARD_TARGETS} chats
        </Text>
      </View>
      <FlashList
        data={shown}
        keyExtractor={(item) => item.key}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <TargetRow
            target={item}
            picked={picked.includes(item.key)}
            onToggle={() => toggle(item.key)}
          />
        )}
        ListEmptyComponent={
          <Text className="px-4 py-6 text-center text-muted">
            {query ? `Nothing matches “${query}”.` : 'No chats yet.'}
          </Text>
        }
      />
      <KeyboardStickyView offset={{ opened: insets.bottom }}>
        <View
          className="gap-3 border-t border-border bg-surface px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          {error && <Notice tone="error" message={error} />}
          <Button
            label={pickedTargets.length > 0 ? `Send to ${pickedTargets.length}` : 'Send'}
            icon={SendIcon}
            loading={busy}
            disabled={pickedTargets.length === 0 || messages.length === 0}
            onPress={() => void send()}
          />
        </View>
      </KeyboardStickyView>
    </View>
  );
}
