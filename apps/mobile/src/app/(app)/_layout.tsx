import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { useCalls } from '@/calls/runtime';
import { startChatData, stopChatData } from '@/engine/chat-store';
import { useChatRuntime } from '@/engine/hooks';
import { conversationOf } from '@/push/notifications';
import { usePhoneRequests } from '@/recovery/approvals';
import { CallMiniWindow, CallPipView } from '@/screens/calls/call-overlays';

// Deep links into a chat still have the tabs underneath to go back to.
export const unstable_settings = { anchor: '(tabs)' };

/** Opens the chat of a tapped message notification, also when the tap launched the app. */
function useNotificationTaps(): void {
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const conversationId = conversationOf(response);
    if (!conversationId) return;
    router.push({ pathname: '/chat/[conversationId]', params: { conversationId } });
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  }, [response, router]);
}

/** A new phone asked for this account (ADR 0022): the approval screen opens once per request. */
function usePhoneRequestPrompt(): void {
  const router = useRouter();
  const next = usePhoneRequests(
    (state) => state.requests.find((r) => !state.dismissed.includes(r.requestId))?.requestId,
  );
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (!next || shown.current.has(next)) return;
    shown.current.add(next);
    router.push('/approve-phone');
  }, [next, router]);
}

/** An incoming call (ADR 0029) opens the call screen once while the app is on screen. */
function useIncomingCallScreen(): void {
  const router = useRouter();
  const ringing = useCalls((state) =>
    state.call?.state === 'incoming' ? state.call.callId : undefined,
  );
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (!ringing || shown.current.has(ringing)) return;
    shown.current.add(ringing);
    router.push('/call');
  }, [ringing, router]);
}

/**
 * Every chat is read into memory as soon as the app is open (not in a headless push wake, which
 * never renders this), so chats open with their messages at once (ADR 0047).
 */
function useChatsInMemory(): void {
  const runtime = useChatRuntime();
  useEffect(() => {
    if (!runtime) return;
    startChatData(runtime);
    return () => stopChatData();
  }, [runtime]);
}

/**
 * The signed-in app: the tabs, with chats and contacts pushed over them (no tab bar there). A
 * call going on shows over every screen as a mini window, and alone in picture-in-picture
 * (ADR 0037).
 */
export default function AppStack() {
  useChatsInMemory();
  useNotificationTaps();
  usePhoneRequestPrompt();
  useIncomingCallScreen();
  return (
    <View style={{ flex: 1 }}>
      <Screens />
      <CallMiniWindow />
      <CallPipView />
    </View>
  );
}

/**
 * Pushed screens slide in from the right in 200 ms (`ios_from_right`, Android's short animation
 * time). Android 13+'s default transition takes 450 ms, which made a chat feel slow to open
 * (ADR 0047). Modals keep the default.
 */
const PUSH = { animation: 'ios_from_right' } as const;
const MODAL = { animation: 'default' } as const;

function Screens() {
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        ...PUSH,
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      {/* The chat draws its own floating header over the wallpaper. */}
      <Stack.Screen name="chat/[conversationId]" options={{ headerShown: false }} />
      <Stack.Screen name="new-chat" options={{ title: 'New chat' }} />
      <Stack.Screen name="new-group" options={{ title: 'New group' }} />
      <Stack.Screen name="group/[groupId]" options={{ title: 'Group info' }} />
      <Stack.Screen name="add-members/[groupId]" options={{ title: 'Add members' }} />
      <Stack.Screen name="search" options={{ title: 'Search' }} />
      <Stack.Screen name="archived" options={{ title: 'Archived chats' }} />
      <Stack.Screen name="contact/[userId]" options={{ title: 'Contact info' }} />
      <Stack.Screen name="circle" options={{ title: 'Circle' }} />
      <Stack.Screen name="report/[userId]" options={{ title: 'Report' }} />
      <Stack.Screen name="scan/[userId]" options={{ title: 'Scan safety code' }} />
      <Stack.Screen
        name="message-info/[messageId]"
        options={{ title: 'Message info', presentation: 'modal', ...MODAL }}
      />
      <Stack.Screen
        name="send-attachment"
        options={{ title: 'Send', presentation: 'modal', ...MODAL }}
      />
      <Stack.Screen
        name="forward"
        options={{ title: 'Forward to', presentation: 'modal', ...MODAL }}
      />
      <Stack.Screen name="media/[messageId]" options={{ title: '' }} />
      <Stack.Screen name="game/ludo-setup" options={{ title: 'Play Ludo' }} />
      <Stack.Screen name="game/ludo" options={{ title: 'Ludo' }} />
      <Stack.Screen name="game/[gameId]" options={{ title: 'Ludo' }} />
      <Stack.Screen
        name="game/start"
        options={{ title: 'Play Ludo', presentation: 'modal', ...MODAL }}
      />
      <Stack.Screen
        name="approve-phone"
        options={{ title: 'New phone', presentation: 'modal', ...MODAL }}
      />
      <Stack.Screen
        name="call"
        options={{
          headerShown: false,
          presentation: 'fullScreenModal',
          gestureEnabled: false,
          ...MODAL,
        }}
      />
    </Stack>
  );
}
