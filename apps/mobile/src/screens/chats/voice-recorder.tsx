// Recording a voice note in the composer (Phase 15): tap the microphone to start, then Send or
// Cancel. The microphone is used only while this panel records; the loudness levels become
// the note's waveform (sent inside the E2EE manifest).
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { removeFile } from '@/attachments/files';
import { durationLabel, waveformFrom } from '@/attachments/rules';
import { SendIcon, Trash2Icon } from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Text } from '@/components/text';
import { CSS_EASE_OUT, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';

/** Long enough for any voice note; far under the size limit. */
const MAX_MS = 15 * 60_000;
const LIVE_BARS = 28;

const RECORDING_PULSE = { from: { opacity: 1 }, to: { opacity: 0.25 } };

export interface VoiceNote {
  uri: string;
  durationMs: number;
  waveform: Uint8Array;
}

export function VoiceRecorder({
  onSend,
  onClose,
}: {
  onSend: (note: VoiceNote) => void;
  onClose: () => void;
}) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, 100);
  const levels = useRef<number[]>([]);
  const [live, setLive] = useState<number[]>([]);
  const [started, setStarted] = useState(false);
  const finished = useRef(false);
  const { palette, floating } = useTheme();
  const { fades } = useMotion();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Microphone access needed',
          'PingDost uses the microphone only while you record a voice note.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open settings', onPress: () => void Linking.openSettings() },
          ],
        );
        onClose();
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (cancelled) return;
      recorder.record();
      setStarted(true);
    })().catch(() => {
      Alert.alert('Could not record', 'The microphone may be in use by another app.');
      onClose();
    });
    return () => {
      cancelled = true;
      if (!finished.current) {
        void recorder
          .stop()
          .then(() => recorder.uri && removeFile(recorder.uri))
          .catch(() => undefined);
      }
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    };
    // Runs once: the panel records from when it opens until Send or Cancel.
  }, []);

  useEffect(() => {
    if (!state.isRecording || state.metering === undefined) return;
    levels.current.push(state.metering);
    setLive(levels.current.slice(-LIVE_BARS));
    if (state.durationMillis >= MAX_MS) void finish(true);
  }, [state.durationMillis]);

  async function finish(send: boolean) {
    if (finished.current) return;
    finished.current = true;
    const durationMs = state.durationMillis;
    try {
      await recorder.stop();
    } catch {
      // Already stopped.
    }
    const uri = recorder.uri;
    if (send && uri && durationMs >= 500) {
      onSend({ uri, durationMs, waveform: waveformFrom(levels.current) });
    } else if (uri) {
      removeFile(uri);
    }
    onClose();
  }

  return (
    <View className="flex-row items-center gap-2">
      <View
        className="h-[52px] flex-1 flex-row items-center gap-2 rounded-2xl bg-surface pl-1 pr-4"
        style={{ ...floating, backgroundColor: palette.surface }}
      >
        <IconButton
          icon={Trash2Icon}
          label="Cancel voice message"
          size={42}
          feedback="warning"
          onPress={() => void finish(false)}
        />
        <Animated.View
          className="h-3 w-3 rounded-full bg-danger"
          style={
            fades
              ? {
                  animationName: RECORDING_PULSE,
                  animationDuration: 700,
                  animationIterationCount: 'infinite',
                  animationDirection: 'alternate',
                  animationTimingFunction: CSS_EASE_OUT,
                }
              : undefined
          }
        />
        <Text
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Recording, ${durationLabel(state.durationMillis)}`}
          className="font-bold text-foreground"
        >
          {durationLabel(state.durationMillis)}
        </Text>
        <View
          importantForAccessibility="no-hide-descendants"
          className="h-8 flex-1 flex-row items-center justify-end gap-[2px]"
        >
          {live.map((level, i) => (
            <View
              key={i}
              className="w-[3px] rounded-full bg-accent"
              style={{ height: Math.max(3, ((Math.max(-50, Math.min(0, level)) + 50) / 50) * 28) }}
            />
          ))}
        </View>
      </View>
      <IconButton
        icon={SendIcon}
        label="Send voice message"
        variant="brand"
        size={52}
        disabled={!started}
        feedback="light"
        onPress={() => void finish(true)}
      />
    </View>
  );
}
