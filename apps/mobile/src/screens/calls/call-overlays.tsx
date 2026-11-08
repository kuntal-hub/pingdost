// What a call shows outside the call screen (ADR 0037):
// - `CallMiniWindow`: while a call goes on and the user is elsewhere in the app, a small window
//   (the other side's picture, or a pill with the name and time) they can drag to either edge.
//   A tap returns to the call screen.
// - `CallPipView`: in picture-in-picture, only the call's picture (or the contact) fills the
//   small window Android shows over other apps.
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';

import { callStatus, inCall, showsRemoteVideo } from '@/calls/logic';
import { useCalls } from '@/calls/runtime';
import { Avatar } from '@/components/avatar';
import { Icon, MicOffIcon, VideoIcon } from '@/components/icon';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { contactName } from '@/engine/contacts';
import { useContact } from '@/engine/hooks';

const MARGIN = 12;
const LIVE = ['outgoing', 'ringing', 'connecting', 'connected', 'reconnecting'];

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function CallMiniWindow() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const call = useCalls((state) => state.call);
  const remote = useCalls((state) => state.remote);
  const pip = useCalls((state) => state.pip);
  const contact = useContact(call?.peerUserId);
  const shown = call !== null && LIVE.includes(call.state) && pathname !== '/call' && !pip;
  const now = useNow(shown);
  const video =
    shown && showsRemoteVideo(call) && remote !== null && remote.getVideoTracks().length > 0;
  const w = video ? 112 : 212;
  const h = video ? 160 : 64;
  const top = insets.top + 64;
  const bottom = height - insets.bottom - 110 - h;
  const x = useSharedValue(width - w - MARGIN);
  const y = useSharedValue(top);
  const start = useSharedValue({ x: 0, y: 0 });

  // A different size (video ↔ voice) or screen: stay on the same edge, inside the screen.
  useEffect(() => {
    const right = x.get() + w / 2 > width / 2;
    x.set(withSpring(right ? width - w - MARGIN : MARGIN, { dampingRatio: 0.9 }));
    y.set(Math.min(Math.max(y.get(), top), bottom));
  }, [w, width, top, bottom, x, y]);

  const pan = usePanGesture({
    activeOffsetX: [-6, 6],
    activeOffsetY: [-6, 6],
    onActivate: () => {
      'worklet';
      start.set({ x: x.get(), y: y.get() });
    },
    onUpdate: (event) => {
      'worklet';
      x.set(start.get().x + event.translationX);
      y.set(start.get().y + event.translationY);
    },
    onDeactivate: (event) => {
      'worklet';
      // To the nearer edge, the way the flick points.
      const centre = x.get() + w / 2 + event.velocityX * 0.1;
      x.set(withSpring(centre > width / 2 ? width - w - MARGIN : MARGIN, { dampingRatio: 0.85 }));
      y.set(withSpring(Math.min(Math.max(y.get(), top), bottom), { dampingRatio: 0.85 }));
    },
  });
  const position = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }],
  }));

  if (!shown) return null;
  const name = contactName(contact);
  const asked = call.videoRequest === 'in';
  const status = asked ? 'Wants to switch to video' : callStatus(call, now);
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[{ position: 'absolute', left: 0, top: 0, width: w, height: h }, position]}
      >
        <Tap
          accessibilityLabel={`Call with ${name}, ${status}`}
          accessibilityHint="Opens the call"
          feedback="selection"
          scaleTo={0.94}
          onPress={() => router.push('/call')}
          className={`h-full w-full overflow-hidden rounded-3xl bg-black ${asked ? 'border-4 border-accent' : ''}`}
        >
          {video ? (
            <View className="flex-1">
              <RTCView
                streamURL={remote.toURL()}
                objectFit={call.remoteScreenSharing ? 'contain' : 'cover'}
                zOrder={1}
                style={StyleSheet.absoluteFill}
              />
              <View className="absolute inset-x-0 bottom-0 bg-black/50 px-2 py-1">
                <Text className="text-center text-xs font-semibold text-white" numberOfLines={1}>
                  {status}
                </Text>
              </View>
            </View>
          ) : (
            <View className="flex-1 flex-row items-center gap-3 px-3">
              <Avatar name={name} url={contact?.avatarUrl ?? null} size={40} />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-bold text-white" numberOfLines={1}>
                  {name}
                </Text>
                <Text className="text-xs font-semibold text-white/80" numberOfLines={1}>
                  {status}
                </Text>
              </View>
              {asked ? <Icon icon={VideoIcon} size={20} color="#FFFFFF" /> : null}
              {call.muted ? <Icon icon={MicOffIcon} size={18} color="#FFFFFF" /> : null}
            </View>
          )}
        </Tap>
      </Animated.View>
    </GestureDetector>
  );
}

export function CallPipView() {
  const pip = useCalls((state) => state.pip);
  const call = useCalls((state) => state.call);
  const remote = useCalls((state) => state.remote);
  const contact = useContact(call?.peerUserId);
  if (!pip || !inCall(call)) return null;
  const video = showsRemoteVideo(call) && remote !== null && remote.getVideoTracks().length > 0;
  const name = contactName(contact);
  return (
    <View style={StyleSheet.absoluteFill} className="items-center justify-center gap-2 bg-black">
      {video ? (
        <RTCView
          streamURL={remote.toURL()}
          objectFit={call.remoteScreenSharing ? 'contain' : 'cover'}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <>
          <Avatar name={name} url={contact?.avatarUrl ?? null} size={56} />
          <Text className="text-sm font-bold text-white" numberOfLines={1}>
            {name}
          </Text>
        </>
      )}
      {call.muted ? (
        <View className="absolute left-2 top-2 rounded-full bg-black/60 p-1.5">
          <Icon icon={MicOffIcon} size={16} color="#FFFFFF" />
        </View>
      ) : null}
    </View>
  );
}
