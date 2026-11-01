// Settings → Storage (REQ §14.1, §14.3; ADR 0018): what PingDost keeps on this phone, automatic
// downloads, per-chat media, and "Clear cache", which removes previews and temporary files
// only and says so. The nearby relay cache (ADR 0025) is listed apart from chats, with its own
// clear action.
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { useAttachmentPrefs } from '@/attachments/prefs';
import type { AutoDownload } from '@/attachments/rules';
import { clearCache, storageUsage, type StorageUsage } from '@/attachments/storage';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { useNames } from '@/engine/groups';
import { useChatRuntime } from '@/engine/hooks';
import { clearRelayCache, useRelay } from '@/nearby/service';
import { formatSize } from '@pingdost/attachments';

const AUTO: { value: AutoDownload; title: string }[] = [
  { value: 'wifi', title: 'On Wi-Fi only' },
  { value: 'always', title: 'On Wi-Fi and mobile data' },
  { value: 'never', title: 'Never (tap each file)' },
];

/** Chat names for the usage list: the contact, or the group's name. */
function useChatNames(): (conversationId: string) => string {
  const runtime = useChatRuntime();
  const people = useNames();
  const [names, setNames] = useState<Record<string, string>>({});
  useFocusEffect(
    useCallback(() => {
      if (!runtime) return;
      void (async () => {
        const next: Record<string, string> = {};
        for (const conversation of await runtime.engine.listConversations()) {
          next[conversation.conversationId] =
            conversation.kind === 'group'
              ? (await runtime.engine.getGroup(conversation.conversationId))?.name || 'Group'
              : people.name(conversation.peerUserId);
        }
        setNames(next);
      })().catch(() => undefined);
    }, [runtime, people]),
  );
  return (id) => names[id] ?? 'Chat';
}

/** "Clear relay cache" (REQ §14.3): only other people's relayed messages; never chats. */
export function confirmClearRelay(): void {
  Alert.alert(
    'Clear relay cache?',
    'This deletes the encrypted messages this phone carries for others. Your own chats and messages stay.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => void clearRelayCache().catch(() => undefined),
      },
    ],
  );
}

export function StorageScreen() {
  const router = useRouter();
  const runtime = useChatRuntime();
  const relay = useRelay();
  const prefs = useAttachmentPrefs((state) => state.prefs);
  const [usage, setUsage] = useState<StorageUsage>();
  const [cleared, setCleared] = useState<string>();
  const [busy, setBusy] = useState(false);
  const chatName = useChatNames();

  const load = useCallback(() => {
    void useAttachmentPrefs
      .getState()
      .load()
      .catch(() => undefined);
    if (!runtime) return;
    void storageUsage()
      .then(setUsage)
      .catch(() => undefined);
  }, [runtime]);
  useFocusEffect(load);

  function confirmClear() {
    const cache = usage ? usage.cacheBytes + usage.thumbnailBytes : 0;
    Alert.alert(
      'Clear cache?',
      `Removes previews and temporary files${cache > 0 ? ` (${formatSize(cache)})` : ''}. Your messages and downloaded files stay. Cleared previews can't be fetched again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear cache',
          onPress: () => {
            setBusy(true);
            void clearCache()
              .then((freed) =>
                setCleared(
                  `Freed ${formatSize(freed)}. Your messages and downloaded files were kept.`,
                ),
              )
              .catch(() => setCleared('Could not clear everything. Try again.'))
              .finally(() => {
                setBusy(false);
                load();
              });
          },
        },
      ],
    );
  }

  const total = usage
    ? usage.mediaBytes + usage.thumbnailBytes + usage.cacheBytes + usage.databaseBytes
    : undefined;

  return (
    <Screen>
      <ListSection title="On this phone">
        <ListRow
          title="PingDost uses"
          subtitle={total === undefined ? 'Working it out…' : formatSize(total)}
        />
        <ListRow
          title="Photos, videos and files"
          subtitle={usage ? `${formatSize(usage.mediaBytes)}, kept encrypted` : '…'}
        />
        <ListRow title="Previews" subtitle={usage ? formatSize(usage.thumbnailBytes) : '…'} />
        <ListRow
          title="Temporary files"
          subtitle={usage ? `${formatSize(usage.cacheBytes)} (files being viewed or sent)` : '…'}
        />
        <ListRow
          title="Messages"
          subtitle={usage ? `${formatSize(usage.databaseBytes)}, encrypted database` : '…'}
        />
        {usage && <ListRow title="Free on this phone" subtitle={formatSize(usage.freeBytes)} />}
      </ListSection>

      <ListSection title="Download photos, videos and files">
        {AUTO.map(({ value, title }) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ selected: prefs.autoDownload === value }}
            accessibilityLabel={title}
            onPress={() =>
              void useAttachmentPrefs
                .getState()
                .setAutoDownload(value)
                .catch(() => undefined)
            }
            className="min-h-[52px] flex-row items-center gap-3 px-4 py-3 active:opacity-70"
          >
            <View
              className={`h-5 w-5 items-center justify-center rounded-full border-2 ${
                prefs.autoDownload === value ? 'border-primary' : 'border-muted'
              }`}
            >
              {prefs.autoDownload === value && (
                <View className="h-2.5 w-2.5 rounded-full bg-primary" />
              )}
            </View>
            <Text className="flex-1 text-base text-foreground">{title}</Text>
          </Pressable>
        ))}
        <Text className="px-4 pb-3 text-muted">
          Previews always download. Files wait on the server only until every device has them, or
          until they expire.
        </Text>
      </ListSection>

      {usage && usage.chats.length > 0 && (
        <ListSection title="Media by chat">
          {usage.chats.map((chat) => (
            <ListRow
              key={chat.conversationId}
              title={chatName(chat.conversationId)}
              subtitle={`${chat.files} file${chat.files === 1 ? '' : 's'} · ${formatSize(chat.fileBytes)}`}
              onPress={() =>
                router.push({
                  pathname: '/storage-chat',
                  params: {
                    conversationId: chat.conversationId,
                    name: chatName(chat.conversationId),
                  },
                })
              }
            />
          ))}
        </ListSection>
      )}

      <ListSection title="Nearby relay cache">
        <ListRow
          title={
            relay.mesh.stored.packets === 0
              ? 'Empty'
              : `${relay.mesh.stored.packets} ${relay.mesh.stored.packets === 1 ? 'message' : 'messages'} · ${formatSize(relay.mesh.stored.bytes)}`
          }
          subtitle="Encrypted messages this phone carries for others nearby, kept apart from your chats. Clearing one never clears the other."
          onPress={() => router.push('/nearby-relay')}
        />
        <ListRow
          title="Clear relay cache"
          subtitle="Deletes only the messages carried for others. Your chats stay."
          {...(relay.mesh.stored.packets > 0 ? { onPress: confirmClearRelay } : {})}
        />
      </ListSection>

      {cleared && <Notice tone="success" message={cleared} />}
      <Button
        label="Clear cache"
        variant="secondary"
        loading={busy}
        disabled={!runtime}
        onPress={confirmClear}
        accessibilityHint="Removes previews and temporary files. Messages and downloaded files stay."
      />
      <Text className="text-muted">
        Clear cache never deletes messages. To delete a chat&apos;s files, open it above; to delete
        a chat, long-press it in Chats.
      </Text>
    </Screen>
  );
}
