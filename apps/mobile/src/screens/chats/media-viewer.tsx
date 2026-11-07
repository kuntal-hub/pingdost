// Viewing a photo or video full screen (Phase 15). The file is decrypted to a temporary copy
// while the viewer is open and deleted when it closes (`view.ts`). Photos pinch to zoom, pan
// when zoomed, and double tap to zoom in or back out.
import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { openPlaintext, releasePlaintext } from '@/attachments/view';
import { Text } from '@/components/text';
import { useChatRuntime } from '@/engine/hooks';
import type { AttachmentInfo, MessageRecord } from '@pingdost/message-engine';

import { exportFile } from './attachment-bubble';

const MAX_ZOOM = 5;

function ZoomableImage({ uri, label }: { uri: string; label: string }) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const pinch = usePinchGesture({
    onUpdate: (event) => {
      'worklet';
      scale.value = Math.min(MAX_ZOOM, Math.max(1, savedScale.value * event.scale));
    },
    onDeactivate: () => {
      'worklet';
      savedScale.value = scale.value;
      if (scale.value <= 1) {
        x.value = withTiming(0);
        y.value = withTiming(0);
        savedX.value = 0;
        savedY.value = 0;
      }
    },
  });
  const pan = usePanGesture({
    minPointers: 1,
    onUpdate: (event) => {
      'worklet';
      if (scale.value <= 1) return;
      x.value = savedX.value + event.translationX;
      y.value = savedY.value + event.translationY;
    },
    onDeactivate: () => {
      'worklet';
      savedX.value = x.value;
      savedY.value = y.value;
    },
  });
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onDeactivate: () => {
      'worklet';
      const zoomed = scale.value > 1;
      scale.value = withTiming(zoomed ? 1 : 2.5);
      savedScale.value = zoomed ? 1 : 2.5;
      x.value = withTiming(0);
      y.value = withTiming(0);
      savedX.value = 0;
      savedY.value = 0;
    },
  });
  const gestures = useSimultaneousGestures(pinch, pan, doubleTap);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={gestures}>
      <Animated.View className="flex-1" style={style}>
        <Image
          source={{ uri }}
          contentFit="contain"
          accessibilityLabel={label}
          accessibilityIgnoresInvertColors
          style={{ width: '100%', height: '100%' }}
        />
      </Animated.View>
    </GestureDetector>
  );
}

function VideoPlayerView({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.play();
  });
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      accessibilityLabel="Video"
      style={{ flex: 1 }}
    />
  );
}

export function MediaViewerScreen({ messageId }: { messageId: string }) {
  const runtime = useChatRuntime();
  const router = useRouter();
  const [message, setMessage] = useState<MessageRecord>();
  const [uri, setUri] = useState<string>();
  const [failed, setFailed] = useState(false);
  const info: AttachmentInfo | null = message?.attachment ?? null;

  useEffect(() => {
    if (!runtime) return;
    void runtime.engine.getMessage(messageId).then(setMessage);
  }, [runtime, messageId]);

  const attachmentId = info?.attachmentId;
  useEffect(() => {
    if (!info || !attachmentId) return;
    let alive = true;
    void openPlaintext(info)
      .then((file) => alive && setUri(file.uri))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      releasePlaintext(attachmentId);
    };
    // Opened once per file; `info` changes identity with every message update.
  }, [attachmentId]);

  const video = info?.mimeType.startsWith('video/') ?? false;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: 'black' }}>
      <Stack.Screen
        options={{
          title: '',
          headerStyle: { backgroundColor: 'black' },
          headerTintColor: 'white',
          headerRight: () =>
            info ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open in another app"
                onPress={() => exportFile(info)}
                className="min-h-[44px] justify-center px-2"
              >
                <Text className="text-base text-white">Share</Text>
              </Pressable>
            ) : null,
        }}
      />
      {failed ? (
        <View className="flex-1 items-center justify-center gap-4 p-6">
          <Text className="text-center text-white">
            This file could not be opened. It may be damaged or no longer on this phone.
          </Text>
          <Pressable accessibilityRole="button" onPress={() => router.back()} className="p-3">
            <Text className="text-base text-white underline">Go back</Text>
          </Pressable>
        </View>
      ) : !uri ? (
        <View className="flex-1 items-center justify-center gap-3">
          <ActivityIndicator color="white" />
          <Text className="text-white">Decrypting…</Text>
        </View>
      ) : video ? (
        <VideoPlayerView uri={uri} />
      ) : (
        <ZoomableImage uri={uri} label={message?.body || 'Photo'} />
      )}
      {message?.body && uri ? (
        <Text className="bg-black/60 px-4 py-3 text-base text-white">{message.body}</Text>
      ) : null}
    </GestureHandlerRootView>
  );
}
