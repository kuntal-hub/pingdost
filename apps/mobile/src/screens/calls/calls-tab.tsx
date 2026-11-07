// The Calls tab (Phase 26, ADR 0029): this phone's call history (kept only here, in the
// encrypted database; the server keeps no call record), call back, and the call settings:
// whether incoming calls may open over the lock screen (Android 14+ lets the user turn that
// off), and "Force relay (TURN)" for testing.
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState, FlatList, Platform, View } from 'react-native';

import { OUTCOME_TEXT, duration } from '@/calls/logic';
import { useCallPrefs } from '@/calls/prefs';
import { dial, useCalls } from '@/calls/runtime';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Toggle } from '@/components/controls';
import { EmptyState } from '@/components/feedback';
import { useTabBarInset } from '@/components/floating-tab-bar';
import {
  Icon,
  PhoneIcon,
  PhoneIncomingIcon,
  PhoneMissedIcon,
  PhoneOutgoingIcon,
  VideoIcon,
} from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { TabHeader } from '@/components/screen';
import { Text } from '@/components/text';
import { contactName } from '@/engine/contacts';
import { useContact } from '@/engine/hooks';
import { useChatStore } from '@/engine/runtime';
import { useTheme } from '@/theme/theme-root';
import type { CallHistoryEntry } from '@pingdost/message-engine';

import { PingdostCalls } from '../../../modules/pingdost-calls/src';

function Row({ entry }: { entry: CallHistoryEntry }) {
  const router = useRouter();
  const contact = useContact(entry.peerUserId);
  const name = contactName(contact);
  const missed = entry.direction === 'in' && entry.outcome === 'missed';
  const detail = [
    entry.video ? 'Video' : 'Voice',
    entry.durationMs > 0 ? duration(entry.durationMs) : OUTCOME_TEXT[entry.outcome],
    new Date(entry.startedAt).toLocaleString(),
  ].join(' · ');
  const direction = missed
    ? PhoneMissedIcon
    : entry.direction === 'in'
      ? PhoneIncomingIcon
      : PhoneOutgoingIcon;
  return (
    <View className="mx-3 flex-row items-center gap-3 rounded-xl px-2 py-3">
      <Avatar name={name} url={contact?.avatarUrl ?? null} size={52} />
      <View className="flex-1 gap-1">
        <Text
          className={`text-base font-bold ${missed ? 'text-danger' : 'text-foreground'}`}
          numberOfLines={1}
        >
          {name}
        </Text>
        <View className="flex-row items-center gap-1">
          <Icon icon={direction} size={14} color={missed ? 'danger' : 'muted'} />
          <Text className="flex-1 text-xs text-muted" numberOfLines={1}>
            {entry.direction === 'in' ? 'Incoming' : 'Outgoing'} · {detail}
          </Text>
        </View>
      </View>
      <IconButton
        icon={entry.video ? VideoIcon : PhoneIcon}
        label={`${entry.video ? 'Video' : 'Voice'} call ${name}`}
        variant="soft"
        feedback="selection"
        onPress={() =>
          void dial(entry.peerUserId, entry.video).then((started) => {
            if (started) router.push('/call');
          })
        }
      />
    </View>
  );
}

function Settings() {
  const { card } = useTheme();
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
    <View className="gap-4 px-5 pb-6 pt-4">
      {Platform.OS === 'android' && !fullScreen ? (
        <View className="gap-2 rounded-xl bg-surface p-4" style={card}>
          <Text className="text-base font-bold text-foreground">
            Calls can&apos;t open over the lock screen
          </Text>
          <Text className="text-sm text-muted">
            Android lets you turn off full-screen notifications for PingDost. Incoming calls then
            show only as a notification.
          </Text>
          <Button
            label="Allow in Android settings"
            variant="ghost"
            onPress={() => PingdostCalls?.openFullScreenIntentSettings()}
          />
        </View>
      ) : null}
      <View className="flex-row items-center gap-3 rounded-xl bg-surface p-4" style={card}>
        <View className="flex-1 gap-1">
          <Text className="text-base font-bold text-foreground">Force relay (TURN)</Text>
          <Text className="text-sm text-muted">
            Testing: send every call through the relay server, as on a network that blocks direct
            calls.
          </Text>
        </View>
        <Toggle
          accessibilityLabel="Force relay (TURN)"
          value={relay}
          onValueChange={(value) => void useCallPrefs.getState().update({ forceRelay: value })}
        />
      </View>
      <Text className="px-1 text-xs text-muted">
        This list is kept only on this phone. PingDost keeps no record of your calls. Calls are
        end-to-end encrypted and go straight between the two devices when they can; otherwise
        PingDost&apos;s relay server forwards the encrypted media, which it cannot hear or see.
      </Text>
    </View>
  );
}

export function CallsTabScreen() {
  const runtime = useChatStore((state) => state.runtime);
  const ended = useCalls((state) => state.call?.endedAt ?? null);
  const notice = useCalls((state) => state.notice);
  const [entries, setEntries] = useState<CallHistoryEntry[]>([]);
  const tabInset = useTabBarInset();

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
    <View className="flex-1 bg-background">
      <TabHeader title="Calls" />
      <FlatList
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: tabInset }}
        data={entries}
        keyExtractor={(entry) => entry.callId}
        renderItem={({ item }) => <Row entry={item} />}
        ListHeaderComponent={
          notice ? (
            <Text className="px-5 pt-2 text-sm font-semibold text-danger">{notice}</Text>
          ) : undefined
        }
        ListEmptyComponent={
          <EmptyState
            icon={PhoneIcon}
            title="No calls yet"
            message="Call someone from your chat with them. Tap the phone icon at the top."
          />
        }
        ListFooterComponent={<Settings />}
      />
    </View>
  );
}
