// Voice notes in the composer (Phase 15; gestures in Phase 40, ADR 0044). Hold the microphone to
// record and lift to send; slide left to cancel; slide up to lock, then stop and listen before
// sending. With a screen reader on, the microphone stays tap to start. The rules are the pure
// machine in `@/attachments/voice-gesture`; this file runs its effects (microphone, files,
// haptics) and draws the controls. The microphone is open only while recording, and the loudness
// levels become the note's waveform (sent inside the E2EE manifest).
import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { AccessibilityInfo, Alert, AppState, Linking, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  FadeIn,
  FadeInDown,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { removeFile } from '@/attachments/files';
import { durationLabel, waveformFrom } from '@/attachments/rules';
import {
  CANCEL_DISTANCE,
  LOCK_DISTANCE,
  MAX_RECORDING_MS,
  MIN_NOTE_MS,
  slideOffset,
  slideOutcome,
  VOICE_IDLE,
  voiceStep,
  type VoiceEvent,
  type VoiceFeedback,
  type VoicePhase,
  type VoiceState,
} from '@/attachments/voice-gesture';
import { callInProgress, useCalls } from '@/calls/runtime';
import {
  ChevronLeftIcon,
  ChevronUpIcon,
  Icon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { Text } from '@/components/text';
import { CSS_EASE_IN_OUT, CSS_EASE_OUT, haptic, useMotion } from '@/theme/motion';
import { createSerialQueue } from '@/theme/serial-queue';
import { useTheme } from '@/theme/theme-root';

const RECORDING_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };
const HOLD_HINT = 'Hold to record, release to send';
const SHORT_HINT = 'Too short to send. Hold a little longer';
const HINT_MS = 2_200;
/** How long the bin shows after a cancel or delete. */
const BIN_MS = 700;
/** The microphone back in place after a drag (it carries the finger's speed). */
const SETTLE = { duration: 400, dampingRatio: 0.8 } as const;
/** The composer's round button and the gap before it: the bar covers the rest of the row. */
const BUTTON_SPACE = 60;
/** Screen readers move the position by this much per swipe. */
const SEEK_STEP_MS = 2_000;

const RECORDING_PULSE = { from: { opacity: 1 }, to: { opacity: 0.25 } };
const NUDGE_LEFT = {
  '0%': { transform: [{ translateX: 0 }] },
  '50%': { transform: [{ translateX: -5 }] },
  '100%': { transform: [{ translateX: 0 }] },
};
const NUDGE_UP = {
  '0%': { transform: [{ translateY: 0 }] },
  '50%': { transform: [{ translateY: -5 }] },
  '100%': { transform: [{ translateY: 0 }] },
};
/** The bin pops in, shakes as the note drops in, and goes. */
const BIN = {
  '0%': { transform: [{ scale: 0.6 }, { rotate: '0deg' }], opacity: 0 },
  '25%': { transform: [{ scale: 1.2 }, { rotate: '-14deg' }], opacity: 1 },
  '45%': { transform: [{ scale: 1 }, { rotate: '10deg' }], opacity: 1 },
  '65%': { transform: [{ scale: 1 }, { rotate: '-6deg' }], opacity: 1 },
  '100%': { transform: [{ scale: 0.85 }, { rotate: '0deg' }], opacity: 0 },
};
const BIN_FADE = { from: { opacity: 1 }, to: { opacity: 0 } };

export interface VoiceNote {
  uri: string;
  durationMs: number;
  waveform: Uint8Array;
}

/** What the composer needs from `useVoiceNote`. */
export interface VoiceController {
  phase: VoicePhase;
  dispatch: (event: VoiceEvent) => void;
  recorder: ReturnType<typeof useAudioRecorder>;
  /** The loudness levels of the recording under way. */
  levels: RefObject<number[]>;
  /** The stopped recording, ready to listen to (`review` only). */
  review: VoiceNote | null;
  /** A short line above the microphone ("Hold to record…"). */
  hint: string | null;
  /** The bin animation after a cancel or delete. */
  binning: boolean;
  /** A screen reader is on: the microphone is tap to start. */
  screenReader: boolean;
  /** How far the microphone follows the finger, and how far it is pressed in (0–1). */
  offsetX: SharedValue<number>;
  offsetY: SharedValue<number>;
  held: SharedValue<number>;
}

/** One recording, from the press until it is sent, reviewed or dropped. */
interface Take {
  /** The recorder was prepared for it: `uri` is its file. */
  uri: string | null;
  started: boolean;
  /** Finished (sent, kept for review or dropped); a pending start gives up. */
  done: boolean;
}

function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setOn);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => subscription.remove();
  }, []);
  return on;
}

async function releaseMicrophone(): Promise<void> {
  await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
}

export function useVoiceNote(onSend: (note: VoiceNote) => void): VoiceController {
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const [state, setState] = useState<VoiceState>(VOICE_IDLE);
  const [review, setReviewState] = useState<VoiceNote | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [binning, setBinning] = useState(false);
  const screenReader = useScreenReader();
  const { fades } = useMotion();
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const held = useSharedValue(0);
  const levels = useRef<number[]>([]);
  // Microphone work runs one step at a time, in order: a release right after a press waits for
  // the start to finish, then stops it.
  const [queue] = useState(() => createSerialQueue());
  const [ctl] = useState(() => ({
    state: VOICE_IDLE,
    take: null as Take | null,
    review: null as VoiceNote | null,
    permitted: false,
    /** The permission dialog is up: Android reports the app as in the background meanwhile. */
    asking: false,
    gone: false,
    onSend,
    fades,
    hintTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    binTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  }));
  ctl.onSend = onSend;
  ctl.fades = fades;

  const { step, finish } = useMemo(() => {
    function setReview(note: VoiceNote | null) {
      ctl.review = note;
      setReviewState(note);
    }

    function showHint(text: string) {
      setHint(text);
      AccessibilityInfo.announceForAccessibility(text);
      clearTimeout(ctl.hintTimer);
      ctl.hintTimer = setTimeout(() => setHint(null), HINT_MS);
    }

    function start(take: Take, tapped: boolean) {
      void queue(async () => {
        if (take.done) return;
        if (callInProgress()) {
          step({ type: 'failed' });
          showHint('Voice messages can’t be recorded during a call');
          return;
        }
        if (!ctl.permitted) {
          ctl.asking = true;
          try {
            const before = await getRecordingPermissionsAsync();
            const answer = before.granted ? before : await requestRecordingPermissionsAsync();
            ctl.permitted = answer.granted;
            if (!answer.granted) {
              step({ type: 'failed' });
              Alert.alert(
                'Microphone access needed',
                'PingDost uses the microphone only while you record a voice message.',
                [
                  { text: 'Not now', style: 'cancel' },
                  { text: 'Open settings', onPress: () => void Linking.openSettings() },
                ],
              );
              return;
            }
            // The permission dialog took the finger away: the next hold records.
            if (!before.granted && !tapped) {
              step({ type: 'failed' });
              showHint(HOLD_HINT);
              return;
            }
          } finally {
            ctl.asking = false;
          }
        }
        try {
          if (take.done) return;
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          if (take.done) return;
          await recorder.prepareToRecordAsync();
          take.uri = recorder.uri;
          if (take.done) return;
          recorder.record();
          take.started = true;
        } catch {
          if (take.done) return;
          step({ type: 'failed' });
          Alert.alert('Could not record', 'The microphone may be in use by another app.');
        }
      });
    }

    /** Stops the take's recording, lets go of the microphone, then sends, keeps or deletes it. */
    function finish(take: Take, effect: 'send' | 'discard' | 'review') {
      take.done = true;
      // This take's levels: a new press starts a new list.
      const taken = levels.current;
      void queue(async () => {
        let durationMs = 0;
        if (take.uri) {
          if (take.started) durationMs = recorder.getStatus().durationMillis;
          try {
            await recorder.stop();
          } catch {
            // Prepared but not started, or already released.
          }
        }
        await releaseMicrophone();
        const { uri } = take;
        const usable = uri !== null && take.started && durationMs >= MIN_NOTE_MS;
        const note = usable ? { uri, durationMs, waveform: waveformFrom(taken) } : null;
        if (note && effect === 'send') {
          ctl.onSend(note);
        } else if (note && effect === 'review' && ctl.state.phase === 'review' && !ctl.gone) {
          setReview(note);
        } else {
          if (uri) removeFile(uri);
          if (effect === 'review') step({ type: 'failed' });
          // The finger lifted before the microphone had recorded enough (it can take a moment
          // to start): say so rather than send nothing silently.
          if (effect === 'send' && !ctl.gone) showHint(SHORT_HINT);
        }
      });
    }

    function endReview(effect: 'send' | 'discard') {
      const note = ctl.review;
      setReview(null);
      if (!note) return;
      if (effect === 'send') ctl.onSend(note);
      else removeFile(note.uri);
    }

    function feedback(kind: VoiceFeedback, event: VoiceEvent) {
      switch (kind) {
        case 'start':
          // A tap has its own haptic (the button's).
          if (event.type === 'press') haptic('light');
          break;
        case 'lock':
          haptic('light');
          break;
        case 'bin':
          // The Delete buttons have their own haptic.
          if (event.type === 'slide') haptic('warning');
          if (ctl.fades) {
            setBinning(true);
            clearTimeout(ctl.binTimer);
            ctl.binTimer = setTimeout(() => setBinning(false), BIN_MS);
          }
          break;
        case 'short':
          showHint(HOLD_HINT);
          break;
      }
    }

    function step(event: VoiceEvent): void {
      if (event.type === 'interrupt' && ctl.asking) return;
      const from = ctl.state;
      const next = voiceStep(from, event);
      ctl.state = next.state;
      if (next.state !== from) setState(next.state);
      if (next.feedback) feedback(next.feedback, event);
      switch (next.effect) {
        case 'start': {
          const take: Take = { uri: null, started: false, done: false };
          ctl.take = take;
          levels.current = [];
          start(take, event.type === 'tap');
          break;
        }
        case 'send':
        case 'discard':
        case 'review':
          if (from.phase === 'review') {
            if (next.effect !== 'review') endReview(next.effect);
          } else if (ctl.take) {
            finish(ctl.take, next.effect);
            ctl.take = null;
          }
          break;
        case undefined:
          break;
      }
    }

    return { step, finish };
  }, [ctl, queue, recorder]);

  // Checked once up front (no prompt), so a press goes straight to the recorder.
  useEffect(() => {
    void getRecordingPermissionsAsync()
      .then((permission) => {
        if (permission.granted) ctl.permitted = true;
      })
      .catch(() => undefined);
  }, [ctl]);

  // Leaving the app or the chat, or a call: a held recording is dropped, a locked one reviewed.
  useEffect(() => {
    const app = AppState.addEventListener('change', (next) => {
      if (next !== 'active') step({ type: 'interrupt' });
    });
    const calls = useCalls.subscribe((now, before) => {
      if (now.call && !before.call) step({ type: 'interrupt' });
    });
    return () => {
      app.remove();
      calls();
    };
  }, [step]);
  useFocusEffect(useCallback(() => () => step({ type: 'interrupt' }), [step]));

  useEffect(() => {
    // Set again on mount: Fast Refresh and StrictMode run the cleanup and then this again.
    ctl.gone = false;
    return () => {
      ctl.gone = true;
      clearTimeout(ctl.hintTimer);
      clearTimeout(ctl.binTimer);
      if (ctl.take) finish(ctl.take, 'discard');
      ctl.take = null;
      if (ctl.review) removeFile(ctl.review.uri);
      ctl.review = null;
    };
  }, [ctl, finish]);

  return {
    phase: state.phase,
    dispatch: step,
    recorder,
    levels,
    review,
    hint,
    binning,
    screenReader,
    offsetX,
    offsetY,
    held,
  };
}

/**
 * Wraps the composer's round button. While `enabled` (voice mode, no screen reader), holding it
 * records: the button follows the finger left (cancel) or up (lock), the lock rail shows above it,
 * and lifting the finger sends.
 */
export function MicHold({
  voice,
  enabled,
  children,
}: {
  voice: VoiceController;
  enabled: boolean;
  children: ReactNode;
}) {
  const { moves, fades } = useMotion();
  const { dispatch, offsetX, offsetY, held } = voice;
  const reported = useSharedValue(false);
  const activated = useSharedValue(false);

  const press = useCallback((at: number) => dispatch({ type: 'press', at }), [dispatch]);
  const slide = useCallback(
    (dx: number, dy: number) => dispatch({ type: 'slide', dx, dy }),
    [dispatch],
  );
  const release = useCallback((at: number) => dispatch({ type: 'release', at }), [dispatch]);
  const lost = useCallback(() => dispatch({ type: 'lost' }), [dispatch]);

  const pan = usePanGesture({
    enabled,
    // Active from the first touch, so a hold without moving is a hold.
    minDistance: 0,
    onBegin: () => {
      'worklet';
      reported.set(false);
      activated.set(false);
      held.set(withSpring(1, SETTLE));
      scheduleOnRN(press, Date.now());
    },
    onActivate: () => {
      'worklet';
      activated.set(true);
    },
    onUpdate: (event) => {
      'worklet';
      if (reported.get()) return;
      const dx = event.translationX;
      const dy = event.translationY;
      if (slideOutcome(dx, dy) !== 'none') {
        // Cancelled or locked: the machine hears it once, and the button goes home.
        reported.set(true);
        scheduleOnRN(slide, dx, dy);
        offsetX.set(withSpring(0, { ...SETTLE, velocity: event.velocityX }));
        offsetY.set(withSpring(0, { ...SETTLE, velocity: event.velocityY }));
        held.set(withSpring(0, SETTLE));
        return;
      }
      const offset = slideOffset(dx, dy);
      offsetX.set(offset.x);
      offsetY.set(offset.y);
    },
    onFinalize: (event) => {
      'worklet';
      offsetX.set(withSpring(0, SETTLE));
      offsetY.set(withSpring(0, SETTLE));
      held.set(withSpring(0, SETTLE));
      if (reported.get()) return;
      reported.set(true);
      // Lifting the finger ends the gesture; the system taking the touch cancels it.
      if (event.canceled && activated.get()) scheduleOnRN(lost);
      else scheduleOnRN(release, Date.now());
    },
  });

  const follow = useAnimatedStyle(() => ({
    transform: moves
      ? [
          { translateX: offsetX.get() },
          { translateY: offsetY.get() },
          { scale: 1 + held.get() * 0.15 },
        ]
      : [],
  }));
  const halo = useAnimatedStyle(() => ({
    opacity: fades ? held.get() * 0.3 : 0,
    transform: [{ scale: moves ? 1 + held.get() * 0.5 : 1.2 }],
  }));

  return (
    // Kept a real view (never flattened by Fabric), so the detector's touch area stays the button.
    // Checked on the emulator: the emoji button beside it is not taken over.
    <View collapsable={false}>
      {voice.phase === 'holding' && <LockRail offsetY={offsetY} />}
      <GestureDetector gesture={pan}>
        <Animated.View style={follow}>
          <Animated.View
            pointerEvents="none"
            className="absolute bottom-0 left-0 right-0 top-0 rounded-full bg-accent"
            style={halo}
          />
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** Above the held microphone: slide up onto the lock to record hands-free. */
function LockRail({ offsetY }: { offsetY: SharedValue<number> }) {
  const { palette, floating } = useTheme();
  const { moves, fades } = useMotion();
  const lock = useAnimatedStyle(() => {
    const progress = interpolate(-offsetY.get(), [0, LOCK_DISTANCE], [0, 1], Extrapolation.CLAMP);
    return moves
      ? { transform: [{ translateY: progress * 8 }, { scale: 1 + progress * 0.3 }] }
      : { opacity: fades ? 0.6 + progress * 0.4 : 1 };
  });
  return (
    <Animated.View
      {...(fades
        ? { entering: (moves ? FadeInDown : FadeIn).duration(160), exiting: FadeOut.duration(120) }
        : {})}
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      className="absolute h-[104px] w-[44px] items-center rounded-full pt-3"
      style={{ left: 4, bottom: 66, backgroundColor: palette.surface, ...floating }}
    >
      <Animated.View style={lock}>
        <Icon icon={LockIcon} size={20} color="foreground" />
      </Animated.View>
      <Animated.View
        className="mt-3"
        style={
          moves
            ? {
                animationName: NUDGE_UP,
                animationDuration: 900,
                animationIterationCount: 'infinite',
                animationTimingFunction: CSS_EASE_IN_OUT,
              }
            : undefined
        }
      >
        <Icon icon={ChevronUpIcon} size={20} color="muted" />
      </Animated.View>
    </Animated.View>
  );
}

/** A short line above the microphone. */
export function VoiceHint({ text }: { text: string }) {
  const { fades } = useMotion();
  return (
    <Animated.View
      {...(fades ? { entering: FadeIn.duration(150), exiting: FadeOut.duration(150) } : {})}
      pointerEvents="none"
      className="absolute right-0 rounded-xl bg-foreground px-3 py-2"
      style={{ bottom: 62 }}
    >
      <Text className="text-sm font-semibold text-background">{text}</Text>
    </Animated.View>
  );
}

/** Covers the composer's field while recording, locked, in review, or binning a note. */
export function VoiceBar({ voice }: { voice: VoiceController }) {
  const { palette, floating } = useTheme();
  const { phase, review } = voice;
  return (
    <View
      className="absolute bottom-0 left-0 top-0 flex-row rounded-2xl"
      style={{ right: BUTTON_SPACE, ...floating, backgroundColor: palette.surface }}
    >
      {phase === 'holding' || phase === 'locked' ? (
        <RecordingRow voice={voice} locked={phase === 'locked'} />
      ) : phase === 'review' ? (
        review ? (
          <ReviewRow voice={voice} note={review} />
        ) : (
          <View className="flex-1 justify-center pl-4">
            <Text className="text-muted">Getting it ready…</Text>
          </View>
        )
      ) : (
        <BinRow />
      )}
    </View>
  );
}

function barHeight(level: number): number {
  return Math.max(3, ((Math.max(-50, Math.min(0, level)) + 50) / 50) * 28);
}

/** The newest loudness levels, right-aligned. */
function LiveWave({ levels, wide }: { levels: number[]; wide: boolean }) {
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      className={`h-8 flex-row items-center justify-end gap-[2px] overflow-hidden ${wide ? 'flex-1' : 'w-[60px]'}`}
    >
      {levels.map((level, i) => (
        <View
          key={i}
          className="w-[3px] rounded-full bg-accent"
          style={{ height: barHeight(level) }}
        />
      ))}
    </View>
  );
}

function RecordingRow({ voice, locked }: { voice: VoiceController; locked: boolean }) {
  const { dispatch, levels, offsetX, recorder } = voice;
  const [{ durationMs, live }, setReading] = useState({ durationMs: 0, live: [] as number[] });
  const { fades, moves } = useMotion();

  // One reading every 100 ms, one state update each: the level joins the waveform here, not in
  // an effect that re-renders (that chain overran React's update limit on a busy JS thread).
  useEffect(() => {
    let limited = false;
    const timer = setInterval(() => {
      const status = recorder.getStatus();
      if (!status.isRecording) return;
      if (status.metering !== undefined) levels.current.push(status.metering);
      setReading({ durationMs: status.durationMillis, live: levels.current.slice(-28) });
      if (status.durationMillis >= MAX_RECORDING_MS && !limited) {
        limited = true;
        dispatch({ type: 'limit' });
      }
    }, 100);
    return () => clearInterval(timer);
  }, [recorder, levels, dispatch]);

  // "Slide to cancel" goes with the finger and fades towards the line.
  const slideHint = useAnimatedStyle(() => {
    const progress = interpolate(-offsetX.get(), [0, CANCEL_DISTANCE], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: fades ? 1 - progress * 0.8 : 1,
      transform: [{ translateX: moves ? offsetX.get() * 0.6 : 0 }],
    };
  });

  const time = durationLabel(durationMs);
  return (
    <View className={`flex-1 flex-row items-center gap-2 ${locked ? 'pl-1 pr-1' : 'pl-4 pr-3'}`}>
      {locked && (
        <IconButton
          icon={Trash2Icon}
          label="Delete voice message"
          size={40}
          feedback="warning"
          onPress={() => dispatch({ type: 'delete' })}
        />
      )}
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
        accessibilityLabel={`Recording, ${time}`}
        className="font-bold text-foreground"
      >
        {time}
      </Text>
      {locked ? (
        <LiveWave levels={live} wide />
      ) : (
        <>
          <Animated.View
            importantForAccessibility="no-hide-descendants"
            className="flex-1 flex-row items-center justify-center"
            style={slideHint}
          >
            <Animated.View
              style={
                moves
                  ? {
                      animationName: NUDGE_LEFT,
                      animationDuration: 900,
                      animationIterationCount: 'infinite',
                      animationTimingFunction: CSS_EASE_IN_OUT,
                    }
                  : undefined
              }
            >
              <Icon icon={ChevronLeftIcon} size={16} color="muted" />
            </Animated.View>
            <Text numberOfLines={1} className="text-sm text-muted">
              Slide to cancel
            </Text>
          </Animated.View>
          <LiveWave levels={live.slice(-12)} wide={false} />
        </>
      )}
      {locked && (
        <IconButton
          icon={SquareIcon}
          label="Stop recording"
          accessibilityHint="Listen to it before sending"
          variant="danger"
          size={40}
          filled
          feedback="light"
          onPress={() => dispatch({ type: 'stop' })}
        />
      )}
    </View>
  );
}

/** Play, pause and scrub the stopped recording before sending it. */
function ReviewRow({ voice, note }: { voice: VoiceController; note: VoiceNote }) {
  const player = useAudioPlayer({ uri: note.uri }, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);
  const progress = useSharedValue(0);
  const scrubbing = useSharedValue(false);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const total = status.duration > 0 ? status.duration * 1_000 : note.durationMs;
  const positionMs = status.currentTime * 1_000;

  useEffect(() => {
    if (scrubbing.get()) return;
    progress.set(total > 0 ? Math.min(1, positionMs / total) : 0);
  }, [positionMs, total]);

  useEffect(() => {
    if (!status.didJustFinish) return;
    player.pause();
    progress.set(0);
    void player.seekTo(0).catch(() => undefined);
  }, [status.didJustFinish]);

  // Playback stops with the app in the background.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') player.pause();
    });
    return () => subscription.remove();
  }, [player]);

  function toggle() {
    if (status.playing) {
      player.pause();
      return;
    }
    if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
      void player.seekTo(0).catch(() => undefined);
    }
    player.play();
  }

  const seek = useCallback(
    (fraction: number) => {
      const seconds = (Math.max(0, Math.min(1, fraction)) * total) / 1_000;
      progress.set(Math.max(0, Math.min(1, fraction)));
      void player
        .seekTo(seconds)
        .catch(() => undefined)
        .finally(() => {
          scrubbing.set(false);
          setScrubMs(null);
        });
    },
    [player, total, progress, scrubbing],
  );

  // Scrubbing uses React Native's responder on the waveform, not a gesture-handler detector: a
  // detector here took touches away from the Play and Delete buttons beside it (seen on Android
  // with gesture-handler 3.3.0). The thumb still moves on the UI thread through `progress`; the
  // time label changes once per second of movement.
  function scrubTo(x: number, release: boolean) {
    if (layoutWidth <= 0) return;
    const fraction = Math.max(0, Math.min(1, x / layoutWidth));
    scrubbing.set(true);
    progress.set(fraction);
    setScrubMs(Math.round((fraction * total) / 1_000) * 1_000);
    if (release) seek(fraction);
  }

  const shownMs = scrubMs ?? (status.playing || positionMs > 0 ? positionMs : total);
  return (
    <View className="flex-1 flex-row items-center gap-1 pl-1 pr-3">
      <IconButton
        icon={Trash2Icon}
        label="Delete voice message"
        size={40}
        feedback="warning"
        onPress={() => voice.dispatch({ type: 'delete' })}
      />
      <IconButton
        icon={status.playing ? PauseIcon : PlayIcon}
        label={status.playing ? 'Pause' : 'Play voice message'}
        variant="soft"
        size={40}
        filled
        onPress={toggle}
      />
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Position in the voice message"
        accessibilityValue={{ text: `${durationLabel(shownMs)} of ${durationLabel(total)}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={({ nativeEvent }) => {
          const delta = nativeEvent.actionName === 'increment' ? SEEK_STEP_MS : -SEEK_STEP_MS;
          if (total > 0) seek((positionMs + delta) / total);
        }}
        onLayout={({ nativeEvent }) => setLayoutWidth(nativeEvent.layout.width)}
        // The waveform itself is the touch target, so `locationX` is measured from its left edge.
        style={{ pointerEvents: 'box-only' }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={({ nativeEvent }) => scrubTo(nativeEvent.locationX, false)}
        onResponderMove={({ nativeEvent }) => scrubTo(nativeEvent.locationX, false)}
        onResponderRelease={({ nativeEvent }) => scrubTo(nativeEvent.locationX, true)}
        onResponderTerminate={() => {
          scrubbing.set(false);
          setScrubMs(null);
        }}
        className="mx-2 h-10 flex-1 justify-center"
      >
        <ScrubWave samples={note.waveform} progress={progress} width={layoutWidth} />
      </View>
      <Text className="min-w-[36px] text-right text-xs font-semibold text-muted">
        {durationLabel(shownMs)}
      </Text>
    </View>
  );
}

function Bars({ bars, tone }: { bars: number[]; tone: string }) {
  return (
    <View className="h-8 flex-row items-center gap-[2px]">
      {bars.map((level, i) => (
        <View
          key={i}
          className={`flex-1 rounded-full ${tone}`}
          style={{ height: Math.max(3, Math.round((level / 255) * 28)) }}
        />
      ))}
    </View>
  );
}

const FLAT = Array.from({ length: 32 }, () => 40);

/**
 * The waveform twice: muted, and the played part in the accent colour on top. The top copy is
 * revealed by two opposite translations on the UI thread, and the props stay the same, so
 * playback and scrubbing never re-render the bars.
 */
const ScrubWave = memo(function ScrubWave({
  samples,
  progress,
  width,
}: {
  samples: Uint8Array;
  progress: SharedValue<number>;
  width: number;
}) {
  const bars = samples.length > 0 ? [...samples] : FLAT;
  const window = useAnimatedStyle(() => ({
    transform: [{ translateX: -(1 - progress.get()) * width }],
  }));
  const content = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.get()) * width }],
  }));
  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.get() * width - 5 }],
  }));
  return (
    <View importantForAccessibility="no-hide-descendants" className="h-8 justify-center">
      <Bars bars={bars} tone="bg-muted/40" />
      {width > 0 && (
        <>
          <Animated.View
            className="absolute bottom-0 left-0 top-0 overflow-hidden"
            style={[{ width }, window]}
          >
            <Animated.View style={[{ width }, content]}>
              <Bars bars={bars} tone="bg-accent" />
            </Animated.View>
          </Animated.View>
          <Animated.View
            className="absolute left-0 h-[10px] w-[10px] rounded-full bg-accent"
            style={[{ top: 11 }, thumb]}
          />
        </>
      )}
    </View>
  );
});

/** After a cancel or delete: the bin takes the note. */
function BinRow() {
  const { moves } = useMotion();
  return (
    <View className="flex-1 flex-row items-center pl-4">
      <Animated.View
        style={{
          animationName: moves ? BIN : BIN_FADE,
          animationDuration: BIN_MS,
          animationFillMode: 'forwards',
          animationTimingFunction: CSS_EASE_OUT,
        }}
      >
        <Icon icon={Trash2Icon} size={22} color="danger" />
      </Animated.View>
    </View>
  );
}
