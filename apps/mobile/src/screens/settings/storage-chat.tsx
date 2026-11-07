// One chat's files on this phone (REQ §14.1, §14.3): pick some and delete their local copies.
// The messages stay and say the file was deleted from this phone; other people keep theirs.
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';

import { attachmentContext } from '@/attachments/context';
import type { MediaItem } from '@/attachments/repo';
import { deleteMedia } from '@/attachments/storage';
import { displayName } from '@/attachments/view';
import { Button } from '@/components/button';
import { CheckMark } from '@/components/controls';
import { EmptyState } from '@/components/feedback';
import {
  FileIcon,
  FileTextIcon,
  Icon,
  ImageIcon,
  MusicIcon,
  VideoIcon,
  type LucideIcon,
} from '@/components/icon';
import { Text } from '@/components/text';
import { useChatRuntime } from '@/engine/hooks';
import { formatSize } from '@pingdost/attachments';
import type { AttachmentInfo } from '@pingdost/message-engine';

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString();

function iconFor(mimeType: string): LucideIcon {
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return VideoIcon;
  if (mimeType.startsWith('audio/')) return MusicIcon;
  return FileTextIcon;
}

export function ChatStorageScreen({
  conversationId,
  name,
}: {
  conversationId: string;
  name: string;
}) {
  const runtime = useChatRuntime();
  const [items, setItems] = useState<{ item: MediaItem; info: AttachmentInfo }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!runtime) return;
    void attachmentContext()
      .repo.mediaIn(conversationId)
      .then((rows) =>
        setItems(
          rows.map((item) => ({ item, info: JSON.parse(item.attachment) as AttachmentInfo })),
        ),
      )
      .catch(() => undefined);
  }, [runtime, conversationId]);
  useEffect(load, [load]);

  const chosen = items.filter(({ item }) => selected.has(item.attachmentId));
  const bytes = chosen.reduce((n, { info }) => n + info.plaintextSize, 0);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirmDelete() {
    Alert.alert(
      `Delete ${chosen.length} file${chosen.length === 1 ? '' : 's'} from this phone?`,
      `Frees about ${formatSize(bytes)}. The messages stay in the chat and say the file was deleted. Other people keep their copies. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            void deleteMedia(chosen.map(({ item }) => item.attachmentId))
              .catch(() => Alert.alert('Could not delete everything', 'Try again.'))
              .finally(() => {
                setBusy(false);
                setSelected(new Set());
                load();
              });
          },
        },
      ],
    );
  }

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ title: name }} />
      <FlatList
        data={items}
        keyExtractor={({ item }) => item.attachmentId}
        contentContainerClassName="p-4 gap-2"
        ListEmptyComponent={
          <EmptyState
            icon={FileIcon}
            title="Nothing here"
            message="No files from this chat are on this phone."
          />
        }
        renderItem={({ item: { item, info } }) => {
          const on = selected.has(item.attachmentId);
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${displayName(info)}, ${formatSize(info.plaintextSize)}, ${dateLabel(item.sortAt)}`}
              onPress={() => toggle(item.attachmentId)}
              className={`min-h-[56px] flex-row items-center gap-3 rounded-xl border-2 px-3 py-2 ${
                on ? 'border-accent bg-accent/10' : 'border-transparent bg-surface'
              }`}
            >
              <View className="h-11 w-11 items-center justify-center rounded-md bg-accent/15">
                <Icon icon={iconFor(info.mimeType)} size={22} color="accent" />
              </View>
              <View className="flex-1">
                <Text numberOfLines={1} className="text-base text-foreground">
                  {displayName(info)}
                </Text>
                <Text className="text-muted">
                  {formatSize(info.plaintextSize)} · {dateLabel(item.sortAt)}
                  {item.direction === 'up' ? ' · sent' : ''}
                </Text>
              </View>
              <CheckMark checked={on} />
            </Pressable>
          );
        }}
      />
      {chosen.length > 0 && (
        <View className="border-t border-border p-4">
          <Button
            label={`Delete ${chosen.length} from this phone (${formatSize(bytes)})`}
            variant="danger"
            loading={busy}
            onPress={confirmDelete}
          />
        </View>
      )}
    </View>
  );
}
