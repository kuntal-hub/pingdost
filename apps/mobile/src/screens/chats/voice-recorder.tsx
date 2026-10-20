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
import { Alert, Linking, Pressable, Text, View } from 'react-native';

import { removeFile } from '@/attachments/files';
import { durationLabel, waveformFrom } from '@/attachments/rules';

/** Long enough for any voice note; far under the size limit. */
const MAX_MS = 15 * 60_000;
const LIVE_BARS = 36;

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
    <View className="flex-row items-center gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel voice message"
        onPress={() => void finish(false)}
        className="min-h-[44px] justify-center px-2"
      >
        <Text className="text-base text-danger">Cancel</Text>
      </Pressable>
      <View
        accessibilityLiveRegion="polite"
        accessibilityLabel={`Recording, ${durationLabel(state.durationMillis)}`}
        className="h-11 flex-1 flex-row items-center gap-[2px] rounded-lg border border-border bg-surface px-3"
      >
        <Text className="mr-2 text-danger">● {durationLabel(state.durationMillis)}</Text>
        {live.map((level, i) => (
          <View
            key={i}
            className="flex-1 rounded-full bg-primary"
            style={{ height: Math.max(3, ((Math.max(-50, Math.min(0, level)) + 50) / 50) * 28) }}
          />
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send voice message"
        disabled={!started}
        onPress={() => void finish(true)}
        className={`min-h-[44px] justify-center rounded-lg bg-primary px-4 ${started ? '' : 'opacity-50'}`}
      >
        <Text className="text-base font-semibold text-on-primary">Send</Text>
      </Pressable>
    </View>
  );
}
