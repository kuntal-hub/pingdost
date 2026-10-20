// Before a photo, video or file is sent (REQ §10.1): what it is, its original size and the
// estimated size and quality after compression (on by default for photos and videos), with
// "Send original" only when the original fits the limit. Files that cannot be sent say why.
import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { removeFile } from '@/attachments/files';
import { compressImage } from '@/attachments/media';
import { usePendingSend } from '@/attachments/pick';
import { durationLabel } from '@/attachments/rules';
import {
  discardDraft,
  SendError,
  sendDraft,
  type Draft,
  type SendJob,
  type SendStage,
} from '@/attachments/send';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { usePalette } from '@/theme/theme-root';
import { CAPTION_MAX, formatSize, IMAGE_PRESETS, type ImageQuality } from '@pingdost/attachments';

type Choice = ImageQuality | 'original' | 'compressed';

interface Option {
  choice: Choice;
  title: string;
  detail: string;
  disabled?: boolean;
}

/** Real sizes for the photo presets: compressing a photo takes a moment, so we just do it. */
function useImageEstimates(draft: Draft | undefined): Partial<Record<ImageQuality, number>> {
  const [sizes, setSizes] = useState<Partial<Record<ImageQuality, number>>>({});
  useEffect(() => {
    if (draft?.sniffed.category !== 'image' || !draft.plan.compressible) return;
    let alive = true;
    void (async () => {
      for (const quality of ['standard', 'hd'] as const) {
        try {
          const out = await compressImage(draft.uri, IMAGE_PRESETS[quality]);
          const size = out.file.size;
          removeFile(out.file);
          if (!alive) return;
          setSizes((current) => ({ ...current, [quality]: size }));
        } catch {
          // The estimate stays unknown.
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [draft]);
  return sizes;
}

function Preview({ draft }: { draft: Draft }) {
  const video = draft.sniffed.category === 'video';
  const player = useVideoPlayer(video ? { uri: draft.uri } : null, (p) => {
    p.muted = true;
  });
  if (draft.sniffed.category === 'image') {
    return (
      <Image
        source={{ uri: draft.uri }}
        contentFit="contain"
        accessibilityLabel="The photo to send"
        style={{ width: '100%', height: 280 }}
      />
    );
  }
  if (video) {
    return (
      <VideoView
        player={player}
        nativeControls
        contentFit="contain"
        accessibilityLabel="The video to send"
        style={{ width: '100%', height: 280 }}
      />
    );
  }
  const icon = draft.voice ? '🎤' : draft.sniffed.category === 'audio' ? '🎵' : '📄';
  return (
    <View className="items-center gap-2 rounded-lg border border-border bg-surface p-6">
      <Text importantForAccessibility="no" className="text-5xl">
        {icon}
      </Text>
      <Text className="text-center text-base font-semibold text-foreground">
        {draft.name ?? 'File'}
      </Text>
      <Text className="text-muted">
        {formatSize(draft.size)} · {draft.sniffed.mimeType}
      </Text>
    </View>
  );
}

function OptionRow({
  option,
  selected,
  onPress,
}: {
  option: Option;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: option.disabled ?? false }}
      accessibilityLabel={`${option.title}. ${option.detail}`}
      disabled={option.disabled}
      onPress={onPress}
      className={`min-h-[56px] flex-row items-center gap-3 border-b border-border px-4 py-3 ${
        option.disabled ? 'opacity-50' : ''
      }`}
    >
      <View
        className={`h-5 w-5 items-center justify-center rounded-full border-2 ${
          selected ? 'border-primary' : 'border-muted'
        }`}
      >
        {selected && <View className="h-2.5 w-2.5 rounded-full bg-primary" />}
      </View>
      <View className="flex-1 gap-1">
        <Text className="text-base text-foreground">{option.title}</Text>
        <Text className="text-muted">{option.detail}</Text>
      </View>
    </Pressable>
  );
}

function stageText(stage: SendStage | undefined): string {
  if (!stage) return '';
  if (stage.stage === 'encrypting') return 'Encrypting on this phone…';
  return stage.percent === undefined
    ? 'Compressing…'
    : `Compressing… ${Math.round(stage.percent)}%`;
}

export function SendAttachmentScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const palette = usePalette();
  const { conversationId, draft, replyTo } = usePendingSend();
  const estimates = useImageEstimates(draft);
  const [caption, setCaption] = useState('');
  const [stage, setStage] = useState<SendStage>();
  const job = useRef<SendJob>(undefined);
  const sent = useRef(false);
  const plan = draft?.plan;
  const [choice, setChoice] = useState<Choice>(() =>
    !plan?.compressible || !plan.compressByDefault
      ? 'original'
      : draft?.sniffed.category === 'image'
        ? 'standard'
        : 'compressed',
  );

  // Leaving without sending drops the app's copy of the file.
  useEffect(
    () => () => {
      job.current?.cancel();
      if (!sent.current && draft) discardDraft(draft);
      usePendingSend.setState({ conversationId: undefined, draft: undefined, replyTo: undefined });
    },
    [draft],
  );

  if (!draft || !conversationId || !plan) {
    return (
      <View className="flex-1 items-center justify-center bg-background p-6">
        <Text className="text-muted">Nothing to send.</Text>
      </View>
    );
  }

  const category = draft.sniffed.category;
  const original = formatSize(draft.size);
  const options: Option[] = [];
  if (category === 'image' && plan.compressible) {
    const estimate = (quality: ImageQuality) =>
      estimates[quality] !== undefined
        ? `about ${formatSize(estimates[quality])}`
        : 'working out the size…';
    options.push(
      {
        choice: 'standard',
        title: `Standard quality (${IMAGE_PRESETS.standard.maxDimension} px)`,
        detail: `${estimate('standard')}. Location and camera details are removed.`,
      },
      {
        choice: 'hd',
        title: `HD (${IMAGE_PRESETS.hd.maxDimension} px)`,
        detail: `${estimate('hd')}. Location and camera details are removed.`,
      },
    );
  }
  if (category === 'video' && plan.compressible && plan.video) {
    options.push({
      choice: 'compressed',
      title: `Compressed (${plan.video.label})`,
      detail: `about ${formatSize(plan.video.estimatedBytes)}. Compressing takes a while; keep PingDost open.`,
    });
  }
  if (plan.compressible) {
    options.push({
      choice: 'original',
      title: 'Send original',
      detail: plan.originalAllowed
        ? `${original}, exactly as it is${category === 'image' ? ', including details such as where it was taken' : ''}.`
        : `${original} is over the 100 MB limit, so it must be compressed.`,
      disabled: !plan.originalAllowed,
    });
  }

  const busy = stage !== undefined;

  function send() {
    if (!draft || !conversationId) return;
    const compress = choice !== 'original';
    const imageQuality: ImageQuality = choice === 'hd' ? 'hd' : 'standard';
    job.current = sendDraft(
      conversationId,
      draft,
      { compress, imageQuality, caption, ...(replyTo ? { replyTo } : {}) },
      setStage,
    );
    job.current.result
      .then(() => {
        sent.current = true;
        router.back();
      })
      .catch((error: unknown) => {
        setStage(undefined);
        if (error instanceof SendError && error.message === 'Cancelled.') return;
        Alert.alert(
          'Could not send',
          error instanceof SendError ? error.message : 'Something went wrong. Please try again.',
        );
      });
  }

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ title: draft.voice ? 'Voice message' : 'Send' }} />
      <ScrollView contentContainerClassName="gap-4 p-5" keyboardShouldPersistTaps="handled">
        <Preview draft={draft} />
        {draft.durationMs ? (
          <Text className="text-center text-muted">{durationLabel(draft.durationMs)}</Text>
        ) : null}
        {plan.rejected ? (
          <Notice tone="error" message={plan.rejected} />
        ) : (
          <>
            {options.length > 0 ? (
              <View className="overflow-hidden rounded-lg border border-border bg-surface">
                <Text className="px-4 pt-3 font-semibold text-muted">Original: {original}</Text>
                {options.map((option) => (
                  <OptionRow
                    key={option.choice}
                    option={option}
                    selected={choice === option.choice}
                    onPress={() => setChoice(option.choice)}
                  />
                ))}
              </View>
            ) : (
              <Text className="text-muted">
                {formatSize(draft.size)}.{' '}
                {category === 'document' ? 'Files are sent as they are.' : ''}
              </Text>
            )}
            <TextInput
              accessibilityLabel="Caption"
              placeholder="Add a caption"
              placeholderTextColor={palette.muted}
              value={caption}
              onChangeText={setCaption}
              maxLength={CAPTION_MAX}
              multiline
              editable={!busy}
              className="max-h-[140px] min-h-[48px] rounded-lg border border-border bg-surface px-3 py-2 text-base text-foreground"
            />
            <Text className="text-muted">
              Encrypted on this phone before it leaves. The server only passes it on and deletes it
              once it is delivered.
            </Text>
          </>
        )}
      </ScrollView>
      <View
        className="gap-2 border-t border-border px-5 pt-3"
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        {busy && (
          <Text accessibilityLiveRegion="polite" className="text-center text-muted">
            {stageText(stage)}
          </Text>
        )}
        {plan.rejected ? (
          <Button label="Close" variant="secondary" onPress={() => router.back()} />
        ) : busy ? (
          <Button label="Cancel" variant="secondary" onPress={() => job.current?.cancel()} />
        ) : (
          <Button label="Send" onPress={send} />
        )}
      </View>
    </View>
  );
}
