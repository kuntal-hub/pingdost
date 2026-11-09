// The call screen (Phase 26, ADR 0029, 0037), opened by a call button, by the in-app ring, by
// the incoming-call notification (`pingdost://call?callId=…&action=answer|show`, also over
// the lock screen) or by the call's mini window. Incoming: Answer / Decline. Live: the other
// side's video, screen (or picture), a self view, mute, camera on/off and flip, voice ↔ video,
// screen sharing, speaker/earpiece/headset/Bluetooth, hang up. "Minimize" (or Back) returns to
// the app with the call going on in a mini window. It closes itself after the call ends.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';

import { callStatus, ERROR_TEXT, inCall, showsRemoteVideo } from '@/calls/logic';
import {
  accept,
  acceptVideo,
  cancelVideoRequest,
  clearEnded,
  decline,
  declineVideo,
  effectChoices,
  hangup,
  requestVideo,
  setAudioRoute,
  setCameraOff,
  setMuted,
  setVideoEffect,
  shareChoices,
  startScreenShare,
  stopScreenShare,
  switchCamera,
  switchToVoice,
  useCalls,
} from '@/calls/runtime';
import { ActionSheet, type SheetAction } from '@/components/action-sheet';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Chip, ChipRow } from '@/components/controls';
import {
  AppWindowIcon,
  CheckIcon,
  ChevronDownIcon,
  Icon,
  MicIcon,
  MicOffIcon,
  MonitorIcon,
  PhoneIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
  SparklesIcon,
  SwitchCameraIcon,
  VideoIcon,
  VideoOffIcon,
  Volume2Icon,
  type LucideIcon,
} from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { contactName } from '@/engine/contacts';
import { useContact } from '@/engine/hooks';
import { CSS_EASE_OUT, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';

import type { AudioRoute } from '../../../modules/pingdost-calls/src';

const ROUTE_LABEL: Record<AudioRoute, string> = {
  earpiece: 'Phone',
  speaker: 'Speaker',
  headset: 'Headset',
  bluetooth: 'Bluetooth',
};

/** How long "They stayed on voice" stays. */
const DECLINED_NOTICE_MS = 4_000;

const RIPPLE = {
  from: { transform: [{ scale: 1 }], opacity: 0.5 },
  to: { transform: [{ scale: 1.9 }], opacity: 0 },
};

/** Rings spreading from the avatar while the call has not connected yet. */
function Ripples({ size }: { size: number }) {
  const { moves } = useMotion();
  if (!moves) return null;
  return (
    <>
      {[0, 600, 1200].map((delay) => (
        <Animated.View
          key={delay}
          className="absolute rounded-full"
          style={{
            width: size,
            height: size,
            backgroundColor: 'rgba(255, 255, 255, 0.35)',
            animationName: RIPPLE,
            animationDuration: 1800,
            animationDelay: delay,
            animationIterationCount: 'infinite',
            animationFillMode: 'both',
            animationTimingFunction: CSS_EASE_OUT,
          }}
        />
      ))}
    </>
  );
}

function RoundButton({
  label,
  description,
  icon,
  onPress,
  tone = 'neutral',
  pressed = false,
}: {
  /** Short, under the button. */
  label: string;
  /** What screen readers say, when the short label is not enough. */
  description?: string;
  icon: LucideIcon;
  onPress: () => void;
  tone?: 'neutral' | 'danger' | 'accept';
  pressed?: boolean;
}) {
  const background =
    tone === 'danger'
      ? 'bg-danger'
      : tone === 'accept'
        ? 'bg-success'
        : pressed
          ? 'bg-white'
          : 'bg-white/20';
  const color =
    tone === 'neutral'
      ? pressed
        ? '#000000'
        : '#FFFFFF'
      : tone === 'danger'
        ? 'on-danger'
        : '#04210F';
  return (
    <View className="w-[72px] items-center gap-1">
      <Tap
        accessibilityLabel={description ?? label}
        accessibilityState={{ selected: pressed }}
        feedback={tone === 'danger' ? 'medium' : 'selection'}
        scaleTo={0.88}
        onPress={onPress}
        className={`h-16 w-16 items-center justify-center rounded-full ${background}`}
      >
        <Icon icon={icon} size={28} color={color} strokeWidth={2.4} />
      </Tap>
      <Text className="text-center text-xs font-semibold text-white" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function CallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ callId?: string; action?: string }>();
  const call = useCalls((state) => state.call);
  const local = useCalls((state) => state.local);
  const remote = useCalls((state) => state.remote);
  const front = useCalls((state) => state.front);
  const routes = useCalls((state) => state.routes);
  const notice = useCalls((state) => state.notice);
  const effect = useCalls((state) => state.effect);
  const contact = useContact(call?.peerUserId);
  const { palette } = useTheme();
  const name = contactName(contact);
  const now = useNow();
  const [routePicker, setRoutePicker] = useState(false);
  const [shareSheet, setShareSheet] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  /** Height of everything below the picture (controls, banners, effects): the self view sits above. */
  const [bottomHeight, setBottomHeight] = useState(240);
  const answered = useRef<string | null>(null);

  // "Answer" on the notification: answer once, as soon as the invite is here.
  useEffect(() => {
    if (params.action !== 'answer' || !params.callId) return;
    if (call?.callId !== params.callId || call.state !== 'incoming') return;
    if (answered.current === params.callId) return;
    answered.current = params.callId;
    void accept(params.callId);
  }, [params.action, params.callId, call?.callId, call?.state]);

  // Closes a moment after the call ended (or when there is none: a stale notification).
  useEffect(() => {
    if (call && call.state !== 'ended') return;
    const timer = setTimeout(
      () => {
        clearEnded();
        if (router.canGoBack()) router.back();
        else router.replace('/chats');
      },
      call ? (call.error ? 4_000 : 1_500) : 8_000,
    );
    return () => clearTimeout(timer);
  }, [call, router]);

  // Notices (no camera, sharing failed) fade after a while.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useCalls.setState({ notice: null }), 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  // A deep backdrop in the scheme's colors, kept dark so white text always reads.
  const backdrop = {
    backgroundImage: `linear-gradient(160deg, ${palette.secondary}, #07070F 62%)`,
  };

  if (!call) {
    return (
      <View className="flex-1 items-center justify-center px-8" style={backdrop}>
        <Text className="text-center text-base font-semibold text-white">
          Waiting for the call…
        </Text>
      </View>
    );
  }

  const minimize = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/chats');
  };
  const live = ['outgoing', 'ringing', 'connecting', 'connected', 'reconnecting'].includes(
    call.state,
  );
  const ringing = ['incoming', 'outgoing', 'ringing', 'connecting'].includes(call.state);
  const remoteVideo = showsRemoteVideo(call) && remote && remote.getVideoTracks().length > 0;
  const localVideo =
    local &&
    local.getVideoTracks().length > 0 &&
    ((call.video && !call.cameraOff) || call.videoRequest === 'out');
  const route = routes?.current ?? null;
  const canSwitch = inCall(call) && call.canVideo;
  const choices = shareChoices();
  const effects = effectChoices();
  const showEffects = effectsOpen && call.video && live && effects.length > 0;
  const declined = call.videoDeclinedAt !== null && now - call.videoDeclinedAt < DECLINED_NOTICE_MS;
  const shareActions: SheetAction[] = choices.map((surface) =>
    surface === 'app'
      ? {
          label: 'One app',
          detail: 'Android asks which app next. Only that app is shared.',
          icon: AppWindowIcon,
          onPress: () => void startScreenShare('app'),
        }
      : {
          label: 'Entire screen',
          detail: 'Everything on your screen, including your notifications.',
          icon: MonitorIcon,
          onPress: () => void startScreenShare('screen'),
        },
  );

  return (
    <View className="flex-1 bg-black" style={backdrop}>
      {remoteVideo ? (
        <RTCView
          streamURL={remote.toURL()}
          // A screen is shown whole; a face fills the screen.
          objectFit={call.remoteScreenSharing ? 'contain' : 'cover'}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
      ) : null}
      {live ? (
        <View className="absolute left-4 z-10" style={{ top: insets.top + 8 }}>
          <Tap
            accessibilityLabel="Minimize the call"
            accessibilityHint="The call goes on in a small window while you use the app"
            feedback="selection"
            onPress={minimize}
            className="h-11 w-11 items-center justify-center rounded-full bg-black/30"
          >
            <Icon icon={ChevronDownIcon} size={26} color="#FFFFFF" />
          </Tap>
        </View>
      ) : null}
      <View className="items-center gap-3 px-6" style={{ paddingTop: insets.top + 56 }}>
        {!remoteVideo && (
          <View className="mb-4 items-center justify-center">
            {ringing && <Ripples size={124} />}
            <Avatar name={name} url={contact?.avatarUrl ?? null} size={124} />
          </View>
        )}
        <Text className="font-display text-4xl text-white" numberOfLines={1}>
          {name}
        </Text>
        <Text className="text-base font-semibold text-white/90" accessibilityLiveRegion="polite">
          {callStatus(call, now)}
          {call.remoteMuted && call.state === 'connected' ? ' · their microphone is off' : ''}
          {call.remoteScreenSharing ? ' · sharing their screen' : ''}
        </Text>
        {call.relayOnly && call.state === 'connected' ? (
          <Text className="text-xs text-white/70">Relayed (TURN), forced</Text>
        ) : null}
        {call.error ? (
          <Text className="text-center text-sm text-white/80">{ERROR_TEXT[call.error]}</Text>
        ) : null}
      </View>
      {localVideo ? (
        <RTCView
          streamURL={local.toURL()}
          objectFit="cover"
          // A front camera shows like a mirror; the back camera shows the world as it is.
          mirror={front}
          zOrder={1}
          style={{
            position: 'absolute',
            right: 16,
            // Above the controls, banners and the effects row, whatever they hold right now.
            bottom: bottomHeight + 12,
            width: 110,
            height: 160,
            borderRadius: 20,
          }}
        />
      ) : null}
      <View className="flex-1" />
      <View onLayout={(event) => setBottomHeight(event.nativeEvent.layout.height)}>
        <View className="mx-4 mb-3 gap-2">
          {call.screenSharing ? (
            <View
              accessibilityLiveRegion="polite"
              className="flex-row items-center gap-3 rounded-2xl bg-danger px-4 py-3"
            >
              <Icon icon={ScreenShareIcon} size={22} color="on-danger" />
              <Text className="flex-1 text-sm font-semibold text-on-danger">
                You are sharing your screen. PingDost itself stays hidden from it.
              </Text>
            </View>
          ) : null}
          {call.videoRequest === 'in' ? (
            <View accessibilityLiveRegion="assertive" className="gap-3 rounded-2xl bg-surface p-4">
              <Text className="text-base font-bold">{name} wants to switch to video</Text>
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Button label="Not now" variant="secondary" onPress={declineVideo} />
                </View>
                <View className="flex-1">
                  <Button label="Switch" icon={VideoIcon} onPress={() => void acceptVideo()} />
                </View>
              </View>
            </View>
          ) : null}
          {call.videoRequest === 'out' ? (
            <View className="flex-row items-center gap-3 rounded-2xl bg-black/50 px-4 py-3">
              <Text className="flex-1 text-sm font-semibold text-white">
                Asking {name} to switch to video…
              </Text>
              <Tap
                accessibilityLabel="Cancel the request"
                feedback="selection"
                onPress={cancelVideoRequest}
                className="min-h-[44px] justify-center rounded-full bg-white/20 px-4"
              >
                <Text className="text-sm font-bold text-white">Cancel</Text>
              </Tap>
            </View>
          ) : null}
          {declined ? (
            <Text
              accessibilityLiveRegion="polite"
              className="self-center rounded-full bg-black/50 px-4 py-2 text-sm text-white"
            >
              {name} stayed on voice
            </Text>
          ) : null}
          {notice ? (
            <Text
              accessibilityLiveRegion="polite"
              className="self-center rounded-2xl bg-black/60 px-4 py-2 text-center text-sm text-white"
            >
              {notice}
            </Text>
          ) : null}
        </View>
        {showEffects ? (
          <View className="mb-3 gap-1">
            <Text className="px-5 text-xs font-semibold text-white/80">
              Effects run on your phone before the picture is encrypted.
            </Text>
            <ChipRow label="Camera effects">
              <Chip
                label="None"
                selected={effect === 'none'}
                onPress={() => setVideoEffect('none')}
              />
              {effects.map((option) => (
                <Chip
                  key={option.id}
                  label={option.label}
                  selected={effect === option.id}
                  onPress={() => setVideoEffect(option.id)}
                />
              ))}
            </ChipRow>
          </View>
        ) : null}
        {routePicker && routes ? (
          <View className="mx-6 mb-4 gap-1 rounded-2xl bg-white/15 p-2">
            {routes.available.map((option) => (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityState={{ selected: option === route }}
                onPress={() => {
                  setAudioRoute(option);
                  setRoutePicker(false);
                }}
                className="min-h-[48px] flex-row items-center justify-between rounded-lg px-4 active:opacity-70"
              >
                <Text className="text-base font-semibold text-white">{ROUTE_LABEL[option]}</Text>
                {option === route && <Icon icon={CheckIcon} size={20} color="#FFFFFF" />}
              </Pressable>
            ))}
          </View>
        ) : null}
        <View
          className="mx-4 flex-row flex-wrap justify-center gap-x-2 gap-y-4 rounded-2xl bg-black/30 px-2 py-4"
          style={{ marginBottom: insets.bottom + 20 }}
        >
          {call.state === 'incoming' ? (
            <>
              <RoundButton
                label="Decline"
                icon={PhoneOffIcon}
                tone="danger"
                onPress={() => void decline()}
              />
              <RoundButton
                label="Answer"
                icon={call.video ? VideoIcon : PhoneIcon}
                tone="accept"
                onPress={() => void accept(call.callId)}
              />
            </>
          ) : live ? (
            <>
              <RoundButton
                label={call.muted ? 'Unmute' : 'Mute'}
                icon={call.muted ? MicOffIcon : MicIcon}
                pressed={call.muted}
                onPress={() => setMuted(!call.muted)}
              />
              {call.video ? (
                <>
                  <RoundButton
                    label={call.cameraOff ? 'Camera on' : 'Camera off'}
                    icon={call.cameraOff ? VideoOffIcon : VideoIcon}
                    pressed={call.cameraOff}
                    onPress={() => setCameraOff(!call.cameraOff)}
                  />
                  <RoundButton
                    label="Flip"
                    description={front ? 'Use the back camera' : 'Use the front camera'}
                    icon={SwitchCameraIcon}
                    onPress={() => void switchCamera()}
                  />
                  {effects.length > 0 ? (
                    <RoundButton
                      label="Effects"
                      description={effectsOpen ? 'Hide camera effects' : 'Show camera effects'}
                      icon={SparklesIcon}
                      pressed={effectsOpen || effect !== 'none'}
                      onPress={() => setEffectsOpen((open) => !open)}
                    />
                  ) : null}
                </>
              ) : null}
              {canSwitch ? (
                call.video ? (
                  <RoundButton
                    label="Voice"
                    description="Switch to a voice call"
                    icon={PhoneIcon}
                    onPress={switchToVoice}
                  />
                ) : (
                  <RoundButton
                    label="Video"
                    description={
                      call.videoRequest === 'out'
                        ? 'Cancel the request to switch to video'
                        : 'Switch to a video call'
                    }
                    icon={VideoIcon}
                    pressed={call.videoRequest === 'out'}
                    onPress={() =>
                      call.videoRequest === 'out' ? cancelVideoRequest() : void requestVideo()
                    }
                  />
                )
              ) : null}
              {canSwitch && choices.length > 0 ? (
                <RoundButton
                  label={call.screenSharing ? 'Stop share' : 'Share'}
                  description={
                    call.screenSharing ? 'Stop sharing your screen' : 'Share your screen'
                  }
                  icon={call.screenSharing ? ScreenShareOffIcon : ScreenShareIcon}
                  pressed={call.screenSharing}
                  onPress={() =>
                    call.screenSharing ? void stopScreenShare() : setShareSheet(true)
                  }
                />
              ) : null}
              <RoundButton
                label={route ? ROUTE_LABEL[route] : 'Audio'}
                description="Choose where the sound plays"
                icon={Volume2Icon}
                pressed={route === 'speaker'}
                onPress={() => setRoutePicker((open) => !open)}
              />
              <RoundButton
                label="Hang up"
                icon={PhoneOffIcon}
                tone="danger"
                onPress={() => void hangup()}
              />
            </>
          ) : null}
        </View>
      </View>
      <ActionSheet
        visible={shareSheet}
        onClose={() => setShareSheet(false)}
        title="What do you want to share?"
        header={
          <Text className="px-5 pb-2 text-sm text-muted">
            PingDost hides its own window from the share, so your chats stay private. The picture
            goes encrypted, straight to {name}.
          </Text>
        }
        actions={shareActions}
      />
    </View>
  );
}
