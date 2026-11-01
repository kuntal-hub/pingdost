// The call screen (Phase 26, ADR 0029), opened by a call button, by the in-app ring, or by
// the incoming-call notification (`pingdost://call?callId=…&action=answer|show`, also over
// the lock screen). Incoming: Answer / Decline. Live: the other side's video (or picture),
// a self view, mute, camera on/off and switch, speaker/earpiece/headset/Bluetooth, hang up.
// It closes itself a moment after the call ends.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Pressable, Text, View } from 'react-native';
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
import { contactName } from '@/engine/contacts';
import { useContact } from '@/engine/hooks';

import type { AudioRoute } from '../../../modules/pingdost-calls/src';

type SymbolName = ComponentProps<typeof SymbolView>['name'];

const ROUTE_LABEL: Record<AudioRoute, string> = {
  earpiece: 'Phone',
  speaker: 'Speaker',
  headset: 'Headset',
  bluetooth: 'Bluetooth',
};

function RoundButton({
  label,
  icon,
  onPress,
  tone = 'neutral',
  pressed = false,
}: {
  label: string;
  icon: SymbolName;
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
  return (
    <View className="items-center gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: pressed }}
        onPress={onPress}
        className={`h-16 w-16 items-center justify-center rounded-full active:opacity-70 ${background}`}
      >
        <SymbolView name={icon} size={28} tintColor={pressed ? '#000000' : '#FFFFFF'} />
      </Pressable>
      <Text className="text-xs text-white">{label}</Text>
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

  if (!call) {
    return (
      <View className="flex-1 items-center justify-center bg-black px-8">
        <Text className="text-center text-base text-white">Waiting for the call…</Text>
      </View>
    );
  }

  const live = ['outgoing', 'ringing', 'connecting', 'connected', 'reconnecting'].includes(
    call.state,
  );
  const remoteVideo =
    call.video && !call.remoteCameraOff && remote && remote.getVideoTracks().length > 0;
  const localVideo = call.video && !call.cameraOff && local && local.getVideoTracks().length > 0;
  const route = routes?.current ?? null;

  return (
    <View className="flex-1 bg-black">
      {remoteVideo ? (
        <RTCView
          streamURL={remote.toURL()}
          objectFit="cover"
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
      ) : null}
      <View className="items-center gap-2 px-6" style={{ paddingTop: insets.top + 32 }}>
        {!remoteVideo && <Avatar name={name} url={contact?.avatarUrl ?? null} size={112} />}
        <Text className="text-2xl font-semibold text-white" numberOfLines={1}>
          {name}
        </Text>
        <Text className="text-base text-white" accessibilityLiveRegion="polite">
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
            bottom: insets.bottom + 140,
            width: 110,
            height: 160,
            borderRadius: 12,
          }}
        />
      ) : null}
      <View className="flex-1" />
      {routePicker && routes ? (
        <View className="mx-6 mb-4 gap-1 rounded-xl bg-white/15 p-2">
          {routes.available.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityState={{ selected: option === route }}
              onPress={() => {
                setAudioRoute(option);
                setRoutePicker(false);
              }}
              className="min-h-[48px] justify-center rounded-lg px-4 active:opacity-70"
            >
              <Text className="text-base text-white">
                {ROUTE_LABEL[option]}
                {option === route ? '  ✓' : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View
        className="flex-row flex-wrap justify-center gap-6 px-6"
        style={{ paddingBottom: insets.bottom + 32 }}
      >
        {call.state === 'incoming' ? (
          <>
            <RoundButton
              label="Decline"
              icon={{ ios: 'phone.down.fill', android: 'call_end' }}
              tone="danger"
              onPress={() => void decline()}
            />
            <RoundButton
              label="Answer"
              icon={
                call.video
                  ? { ios: 'video.fill', android: 'videocam' }
                  : { ios: 'phone.fill', android: 'call' }
              }
              tone="accept"
              onPress={() => void accept(call.callId)}
            />
          </>
        ) : live ? (
          <>
            <RoundButton
              label={call.muted ? 'Unmute' : 'Mute'}
              icon={{ ios: 'mic.slash.fill', android: 'mic_off' }}
              pressed={call.muted}
              onPress={() => setMuted(!call.muted)}
            />
            {call.video ? (
              <>
                <RoundButton
                  label={call.cameraOff ? 'Camera on' : 'Camera off'}
                  icon={{ ios: 'video.slash.fill', android: 'videocam_off' }}
                  pressed={call.cameraOff}
                  onPress={() => setCameraOff(!call.cameraOff)}
                />
                <RoundButton
                  label="Flip"
                  icon={{ ios: 'camera.rotate', android: 'cameraswitch' }}
                  onPress={() => void switchCamera()}
                />
              </>
            ) : null}
            <RoundButton
              label={route ? ROUTE_LABEL[route] : 'Audio'}
              icon={{ ios: 'speaker.wave.2.fill', android: 'volume_up' }}
              pressed={route === 'speaker'}
              onPress={() => setRoutePicker((open) => !open)}
            />
            <RoundButton
              label="Hang up"
              icon={{ ios: 'phone.down.fill', android: 'call_end' }}
              tone="danger"
              onPress={() => void hangup()}
            />
          </>
        ) : null}
      </View>
    </View>
  );
}
