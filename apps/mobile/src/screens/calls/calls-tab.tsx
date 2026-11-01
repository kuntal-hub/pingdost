// The Calls tab (Phase 26, ADR 0029): this phone's call history (kept only here, in the
// encrypted database; the server keeps no call record), call back, and the call settings:
// whether incoming calls may open over the lock screen (Android 14+ lets the user turn that
// off), and "Force relay (TURN)" for testing.
import { useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { AppState, FlatList, Platform, Pressable, Switch, Text, View } from 'react-native';

import { OUTCOME_TEXT, duration } from '@/calls/logic';
import { useCallPrefs } from '@/calls/prefs';
import { dial, useCalls } from '@/calls/runtime';
import { Avatar } from '@/components/avatar';
import { contactName } from '@/engine/contacts';
import { useContact } from '@/engine/hooks';
import { useChatStore } from '@/engine/runtime';
import { usePalette } from '@/theme/theme-root';
import type { CallHistoryEntry } from '@pingdost/message-engine';

import { PingdostCalls } from '../../../modules/pingdost-calls/src';

function Row({ entry }: { entry: CallHistoryEntry }) {
  const router = useRouter();
  const palette = usePalette();
  const contact = useContact(entry.peerUserId);
  const name = contactName(contact);
  const missed = entry.direction === 'in' && entry.outcome === 'missed';
  const detail = [
    entry.direction === 'in' ? 'Incoming' : 'Outgoing',
    entry.video ? 'video' : 'voice',
    entry.durationMs > 0 ? duration(entry.durationMs) : OUTCOME_TEXT[entry.outcome],
  ].join(' · ');
  return (
    <View className="flex-row items-center gap-3 px-4 py-2">
      <Avatar name={name} url={contact?.avatarUrl ?? null} size={44} />
      <View className="flex-1">
        <Text
          className={`text-base font-semibold ${missed ? 'text-danger' : 'text-foreground'}`}
          numberOfLines={1}
        >
          {name}
        </Text>
        <Text className="text-sm text-muted" numberOfLines={1}>
          {detail} · {new Date(entry.startedAt).toLocaleString()}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${entry.video ? 'Video' : 'Voice'} call ${name}`}
        onPress={() =>
          void dial(entry.peerUserId, entry.video).then((started) => {
            if (started) router.push('/call');
          })
        }
        className="min-h-[48px] min-w-[48px] items-center justify-center active:opacity-70"
      >
        <SymbolView
          name={
            entry.video ? { ios: 'video', android: 'videocam' } : { ios: 'phone', android: 'call' }
          }
          size={24}
          tintColor={palette.primary}
        />
      </Pressable>
    </View>
  );
}

function Settings() {
  const relay = useCallPrefs((state) => state.prefs.forceRelay);
  const [fullScreen, setFullScreen] = useState(
    () => PingdostCalls?.canUseFullScreenIntent() ?? true,
  );
  useFocusEffect(
    useCallback(() => {
      void useCallPrefs.getState().load();
      // Back from Android settings: read the permission again.
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') setFullScreen(PingdostCalls?.canUseFullScreenIntent() ?? true);
      });
      return () => sub.remove();
    }, []),
  );
  return (
    <View className="gap-3 px-4 pb-6 pt-2">
      <Text className="text-sm text-muted">
        This list is kept only on this phone. PingDost keeps no record of your calls. Calls are
        end-to-end encrypted and go straight between the two devices when they can; otherwise
        PingDost&apos;s relay server forwards the encrypted media, which it cannot hear or see.
      </Text>
      {Platform.OS === 'android' && !fullScreen ? (
        <View className="gap-2 rounded-xl border border-border bg-surface p-4">
          <Text className="text-base font-semibold text-foreground">
            Calls can&apos;t open over the lock screen
          </Text>
          <Text className="text-sm text-muted">
            Android lets you turn off full-screen notifications for PingDost. Incoming calls then
            show only as a notification.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => PingdostCalls?.openFullScreenIntentSettings()}
            className="min-h-[44px] justify-center active:opacity-70"
          >
            <Text className="text-base text-primary">Allow in Android settings</Text>
          </Pressable>
        </View>
      ) : null}
      <View className="flex-row items-center gap-3">
        <View className="flex-1">
          <Text className="text-base text-foreground">Force relay (TURN)</Text>
          <Text className="text-sm text-muted">
            Testing: send every call through the relay server, as on a network that blocks direct
            calls.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Force relay (TURN)"
          value={relay}
          onValueChange={(value) => void useCallPrefs.getState().update({ forceRelay: value })}
        />
      </View>
    </View>
  );
}

export function CallsTabScreen() {
  const runtime = useChatStore((state) => state.runtime);
  const ended = useCalls((state) => state.call?.endedAt ?? null);
  const notice = useCalls((state) => state.notice);
  const [entries, setEntries] = useState<CallHistoryEntry[]>([]);

  useFocusEffect(
    useCallback(() => {
      if (!runtime) return;
      // Reloaded on focus and after each call (the entry is written as the call ends).
      const timer = setTimeout(
        () => void runtime.engine.callHistory().then(setEntries, () => setEntries([])),
        ended ? 300 : 0,
      );
      return () => clearTimeout(timer);
    }, [runtime, ended]),
  );

  return (
    <FlatList
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      data={entries}
      keyExtractor={(entry) => entry.callId}
      renderItem={({ item }) => <Row entry={item} />}
      ListHeaderComponent={
        notice ? <Text className="px-4 pt-2 text-sm text-danger">{notice}</Text> : undefined
      }
      ListEmptyComponent={
        <Text className="px-4 py-6 text-base text-muted">
          No calls yet. Call a contact from your chat with them.
        </Text>
      }
      ListFooterComponent={<Settings />}
    />
  );
}
