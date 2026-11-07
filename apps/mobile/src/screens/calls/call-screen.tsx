// The call screen (Phase 26, ADR 0029), opened by a call button, by the in-app ring, or by
// the incoming-call notification (`pingdost://call?callId=…&action=answer|show`, also over
// the lock screen). Incoming: Answer / Decline. Live: the other side's video (or picture),
// a self view, mute, camera on/off and switch, speaker/earpiece/headset/Bluetooth, hang up.
// It closes itself a moment after the call ends.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';

import { callStatus, ERROR_TEXT } from '@/calls/logic';
import {
  accept,
  clearEnded,
  decline,
  hangup,
  setAudioRoute,
  setCameraOff,
  setMuted,
  switchCamera,
  useCalls,
} from '@/calls/runtime';
import { Avatar } from '@/components/avatar';
import {
  CheckIcon,
  Icon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
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
  icon,
  onPress,
  tone = 'neutral',
  pressed = false,
}: {
  label: string;
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
    <View className="items-center gap-1">
      <Tap
        accessibilityLabel={label}
        accessibilityState={{ selected: pressed }}
        feedback={tone === 'danger' ? 'medium' : 'selection'}
        scaleTo={0.88}
        onPress={onPress}
        className={`h-16 w-16 items-center justify-center rounded-full ${background}`}
      >
        <Icon icon={icon} size={28} color={color} strokeWidth={2.4} />
      </Tap>
      <Text className="text-xs font-semibold text-white">{label}</Text>
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
  const routes = useCalls((state) => state.routes);
  const contact = useContact(call?.peerUserId);
  const { palette } = useTheme();
  const name = contactName(contact);
  const now = useNow();
  const [routePicker, setRoutePicker] = useState(false);
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

  const live = ['outgoing', 'ringing', 'connecting', 'connected', 'reconnecting'].includes(
    call.state,
  );
  const ringing = ['incoming', 'outgoing', 'ringing', 'connecting'].includes(call.state);
  const remoteVideo =
    call.video && !call.remoteCameraOff && remote && remote.getVideoTracks().length > 0;
  const localVideo = call.video && !call.cameraOff && local && local.getVideoTracks().length > 0;
  const route = routes?.current ?? null;

  return (
    <View className="flex-1 bg-black" style={backdrop}>
      {remoteVideo ? (
        <RTCView
          streamURL={remote.toURL()}
          objectFit="cover"
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
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
          mirror
          zOrder={1}
          style={{
            position: 'absolute',
            right: 16,
            bottom: insets.bottom + 180,
            width: 110,
            height: 160,
            borderRadius: 20,
          }}
        />
      ) : null}
      <View className="flex-1" />
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
        className="mx-4 flex-row flex-wrap justify-center gap-5 rounded-2xl bg-black/30 px-3 py-4"
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
                  icon={SwitchCameraIcon}
                  onPress={() => void switchCamera()}
                />
              </>
            ) : null}
            <RoundButton
              label={route ? ROUTE_LABEL[route] : 'Audio'}
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
  );
}
