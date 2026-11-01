// The attachment inside a chat bubble (Phase 15, ADR 0018): a photo or video tile with its
// preview, a voice note or audio player, or a document card, each with its transfer state
// and controls (download, pause, resume, cancel, retry). Opening a file decrypts it to a
// short-lived temporary copy; handing it to another app says that it leaves PingDost.
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';

import { useAttachmentRows, useThumbnail } from '@/attachments/hooks';
import type { AttachmentRow } from '@/attachments/repo';
import { durationLabel } from '@/attachments/rules';
import { transferStatus, type TransferAction } from '@/attachments/status';
import {
  cancelDownload,
  cancelUpload,
  fetchNow,
  pause,
  resumeUpload,
} from '@/attachments/transfers';
import { displayName, openPlaintext, releasePlaintext } from '@/attachments/view';
import { attachmentType } from '@/engine/labels';
import { cancelMesh, pauseMesh, resumeMesh, useMeshFiles } from '@/nearby/files';
import { usePalette } from '@/theme/theme-root';
import { formatSize } from '@pingdost/attachments';
import type { AttachmentInfo, MessageRecord } from '@pingdost/message-engine';
import { fromBase64 } from '@pingdost/protocol';

const TILE_WIDTH = 240;

const ACTION_LABELS: Record<TransferAction, string> = {
  download: 'Download',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  retry: 'Retry',
};

async function act(action: TransferAction, row: AttachmentRow): Promise<void> {
  // Files over the nearby mesh (ADR 0027) have their own controls.
  if (row.via === 'mesh') {
    if (action === 'pause') return pauseMesh(row);
    if (action === 'resume' || action === 'retry') return resumeMesh(row);
    if (action === 'cancel') return cancelMesh(row);
    return;
  }
  switch (action) {
    case 'download':
    case 'retry':
      return fetchNow(row);
    case 'pause':
      return pause(row);
    case 'resume':
      return row.direction === 'up' ? resumeUpload(row.messageId) : fetchNow(row);
    case 'cancel':
      if (row.direction === 'down') return cancelDownload(row);
      return new Promise((resolve) =>
        Alert.alert(
          'Cancel sending?',
          'The file is removed from this chat. Nobody has received it yet.',
          [
            { text: 'Keep sending', style: 'cancel', onPress: () => resolve() },
            {
              text: 'Cancel sending',
              style: 'destructive',
              onPress: () => void cancelUpload(row.messageId).finally(resolve),
            },
          ],
        ),
      );
  }
}

/** Hands the decrypted file to another app, after saying what that means. */
export function exportFile(info: AttachmentInfo): void {
  Alert.alert(
    'Open in another app?',
    'The other app gets a decrypted copy. PingDost can no longer protect or delete it there.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Continue',
        onPress: () => {
          void (async () => {
            try {
              if (!(await Sharing.isAvailableAsync())) throw new Error('sharing unavailable');
              const file = await openPlaintext(info, { exported: true });
              await Sharing.shareAsync(file.uri, {
                mimeType: info.mimeType,
                dialogTitle: displayName(info),
              });
              releasePlaintext(info.attachmentId);
            } catch {
              Alert.alert('Could not open the file', 'Try again in a moment.');
            }
          })();
        },
      },
    ],
  );
}

function Controls({
  row,
  actions,
  outgoing,
}: {
  row: AttachmentRow | undefined;
  actions: TransferAction[];
  outgoing: boolean;
}) {
  if (!row || actions.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {actions.map((action) => (
        <Pressable
          key={action}
          accessibilityRole="button"
          accessibilityLabel={ACTION_LABELS[action]}
          onPress={() => void act(action, row).catch(() => undefined)}
          className={`min-h-[36px] justify-center rounded-full border px-3 ${
            outgoing ? 'border-on-primary/60' : 'border-border'
          }`}
        >
          <Text className={`font-semibold ${outgoing ? 'text-on-primary' : 'text-primary'}`}>
            {ACTION_LABELS[action]}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ProgressBar({ value, outgoing }: { value: number; outgoing: boolean }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      className={`h-1.5 overflow-hidden rounded-full ${outgoing ? 'bg-on-primary/30' : 'bg-border'}`}
    >
      <View
        className={outgoing ? 'h-full bg-on-primary' : 'h-full bg-primary'}
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </View>
  );
}

function MediaTile({
  message,
  info,
  thumbnail,
  available,
  busy,
  onOpen,
  onLongPress,
}: {
  message: MessageRecord;
  info: AttachmentInfo;
  thumbnail: string | undefined;
  available: boolean;
  busy: boolean;
  onOpen: () => void;
  onLongPress: () => void;
}) {
  const palette = usePalette();
  const video = info.mimeType.startsWith('video/');
  const ratio =
    info.width && info.height ? Math.min(2, Math.max(0.5, info.width / info.height)) : 4 / 3;
  const { icon, name } = attachmentType(message);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${formatSize(info.plaintextSize)}${available ? '. Double tap to open' : ''}`}
      onPress={available ? onOpen : undefined}
      onLongPress={onLongPress}
      className="overflow-hidden rounded-md bg-black/10"
      style={{ width: TILE_WIDTH, height: TILE_WIDTH / ratio }}
    >
      {thumbnail ? (
        <Image
          source={{ uri: thumbnail }}
          contentFit="cover"
          accessibilityIgnoresInvertColors
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <Text importantForAccessibility="no" className="text-4xl">
            {icon}
          </Text>
        </View>
      )}
      {(video || busy) && (
        <View className="absolute inset-0 items-center justify-center">
          <View className="h-12 w-12 items-center justify-center rounded-full bg-black/50">
            {busy ? (
              <ActivityIndicator color={palette['on-primary']} />
            ) : (
              <Text importantForAccessibility="no" className="text-xl text-white">
                ▶
              </Text>
            )}
          </View>
        </View>
      )}
      {video && info.durationMs ? (
        <Text className="absolute bottom-1 right-2 rounded bg-black/50 px-1 text-sm text-white">
          {durationLabel(info.durationMs)}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Up to 64 bars from the manifest; the played part in the stronger colour. */
function Waveform({
  samples,
  played,
  outgoing,
}: {
  samples: Uint8Array;
  played: number;
  outgoing: boolean;
}) {
  const bars = samples.length > 0 ? [...samples] : Array.from({ length: 32 }, () => 40);
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      className="h-8 flex-1 flex-row items-center gap-[2px]"
    >
      {bars.map((level, i) => {
        const done = i / bars.length < played;
        return (
          <View
            key={i}
            className={`flex-1 rounded-full ${
              outgoing
                ? done
                  ? 'bg-on-primary'
                  : 'bg-on-primary/40'
                : done
                  ? 'bg-primary'
                  : 'bg-muted/40'
            }`}
            style={{ height: Math.max(3, Math.round((level / 255) * 30)) }}
          />
        );
      })}
    </View>
  );
}

function AudioPlayerRow({
  info,
  available,
  outgoing,
}: {
  info: AttachmentInfo;
  available: boolean;
  outgoing: boolean;
}) {
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const loaded = useRef(false);
  const samples = info.waveform ? fromBase64(info.waveform) : new Uint8Array(0);
  const total = status.duration > 0 ? status.duration * 1_000 : (info.durationMs ?? 0);
  const played = total > 0 ? Math.min(1, (status.currentTime * 1_000) / total) : 0;

  // The decrypted copy goes with the bubble.
  const { attachmentId } = info;
  useEffect(
    () => () => {
      if (loaded.current) releasePlaintext(attachmentId);
    },
    [attachmentId],
  );

  async function toggle() {
    if (status.playing) {
      player.pause();
      return;
    }
    try {
      if (!loaded.current) {
        const file = await openPlaintext(info);
        loaded.current = true;
        player.replace({ uri: file.uri });
      } else if (
        status.didJustFinish ||
        (status.duration > 0 && status.currentTime >= status.duration)
      ) {
        await player.seekTo(0);
      }
      player.play();
    } catch {
      Alert.alert('Could not play this', 'The file may be damaged.');
    }
  }

  return (
    <View className="flex-row items-center gap-3" style={{ width: TILE_WIDTH }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause' : 'Play voice message'}
        accessibilityState={{ disabled: !available }}
        disabled={!available}
        onPress={() => void toggle()}
        className={`h-11 w-11 items-center justify-center rounded-full ${
          outgoing ? 'bg-on-primary/20' : 'bg-primary/15'
        } ${available ? '' : 'opacity-50'}`}
      >
        <Text className={`text-lg ${outgoing ? 'text-on-primary' : 'text-primary'}`}>
          {status.playing ? '❚❚' : '▶'}
        </Text>
      </Pressable>
      <Waveform samples={samples} played={played} outgoing={outgoing} />
      <Text className={outgoing ? 'text-on-primary' : 'text-muted'}>
        {durationLabel(
          status.playing || status.currentTime > 0 ? status.currentTime * 1_000 : total,
        )}
      </Text>
    </View>
  );
}

function FileCard({
  info,
  available,
  outgoing,
  onLongPress,
}: {
  info: AttachmentInfo;
  available: boolean;
  outgoing: boolean;
  onLongPress: () => void;
}) {
  const name = displayName(info);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${formatSize(info.plaintextSize)}${available ? '. Double tap to open in another app' : ''}`}
      onPress={available ? () => exportFile(info) : undefined}
      onLongPress={onLongPress}
      className={`flex-row items-center gap-3 rounded-md px-2 py-2 ${
        outgoing ? 'bg-on-primary/10' : 'bg-background'
      }`}
      style={{ width: TILE_WIDTH }}
    >
      <Text importantForAccessibility="no" className="text-3xl">
        📄
      </Text>
      <View className="flex-1">
        <Text
          numberOfLines={2}
          className={`font-semibold ${outgoing ? 'text-on-primary' : 'text-foreground'}`}
        >
          {name}
        </Text>
        <Text className={outgoing ? 'text-on-primary/80' : 'text-muted'}>
          {formatSize(info.plaintextSize)} · {info.mimeType.split('/')[1]?.toUpperCase() ?? 'FILE'}
        </Text>
      </View>
    </Pressable>
  );
}

export function AttachmentContent({
  message,
  outgoing,
  onLongPress,
}: {
  message: MessageRecord;
  outgoing: boolean;
  onLongPress: () => void;
}) {
  const router = useRouter();
  const info = message.attachment;
  const rows = useAttachmentRows(message);
  const thumbnail = useThumbnail(message, rows.thumbnail);
  const mesh = useMeshFiles((state) =>
    rows.file?.via === 'mesh'
      ? rows.file.direction === 'up'
        ? state.outgoing[rows.file.attachmentId]
        : state.incoming[rows.file.attachmentId]
      : undefined,
  );
  if (!info) return null;
  const status = transferStatus(rows.file, rows.fileProgress, info.plaintextSize, mesh);
  const media = info.mimeType.startsWith('image/') || info.mimeType.startsWith('video/');
  const audio = info.mimeType.startsWith('audio/');
  const busy = rows.file?.state === 'transferring' && rows.file.direction === 'down';

  return (
    <View className="gap-2">
      {media ? (
        <MediaTile
          message={message}
          info={info}
          thumbnail={thumbnail}
          available={status.available}
          busy={busy}
          onOpen={() =>
            router.push({
              pathname: '/media/[messageId]',
              params: { messageId: message.messageId },
            })
          }
          onLongPress={onLongPress}
        />
      ) : audio ? (
        <AudioPlayerRow info={info} available={status.available} outgoing={outgoing} />
      ) : (
        <FileCard
          info={info}
          available={status.available}
          outgoing={outgoing}
          onLongPress={onLongPress}
        />
      )}
      {status.progress !== undefined && <ProgressBar value={status.progress} outgoing={outgoing} />}
      {status.text !== '' && (
        <Text
          accessibilityLiveRegion="polite"
          className={outgoing ? 'text-on-primary/90' : 'text-muted'}
        >
          {status.text}
        </Text>
      )}
      <Controls row={rows.file} actions={status.actions} outgoing={outgoing} />
    </View>
  );
}
