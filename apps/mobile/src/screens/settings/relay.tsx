// Settings → Nearby relay (Phase 23, ADR 0025; REQ §11.4, §11.5): the explicit opt-in "Allow
// this device to relay messages", what relays can see, what it costs, the pause rules, the
// relay cache and the limits Android and iOS put on background work. Off by default; off stops
// relaying at once.
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { Toggle } from '@/components/controls';
import { CheckIcon, Icon } from '@/components/icon';
import { ListRow, ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { describeRelay, type RelayPrefs } from '@/nearby/relay';
import { refreshNearby, setRelayPrefs, startNearby, useNearby, useRelay } from '@/nearby/service';
import { NEARBY_COPY } from '@/nearby/status';
import { formatSize } from '@pingdost/attachments';

import { nearbyPlatform } from './nearby';
import { confirmClearRelay } from './storage';

const BATTERY_LEVELS = [10, 20, 30, 50] as const;
const STORAGE_LEVELS = [512, 1024, 2048] as const;

function save(change: Partial<RelayPrefs>): void {
  void setRelayPrefs(change).catch(() => undefined);
}

/** What relaying means, shown before and while it is on. */
export function RelayExplainer() {
  return (
    <>
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        What relaying does
      </Text>
      <Text className="text-foreground">
        With no internet, PingDost phones can pass messages along for each other. When this is on,
        your phone keeps encrypted messages for people nearby for a while and hands them on when it
        meets another PingDost phone, until they reach the person they are for.
      </Text>
      <Text className="text-foreground">
        Delivery this way is opportunistic: a message arrives only if a chain of phones happens to
        reach its recipient before it expires. A message shows &quot;Delivered&quot; only when the
        recipient&apos;s phone confirms it.
      </Text>
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        What a relay can see
      </Text>
      <Text className="text-muted">
        Relayed messages stay end-to-end encrypted: no relay can read or change them. A relay does
        see some routing details: a code for the recipient&apos;s phone and one for the
        sender&apos;s (both change every day), when the message expires, how many more hops it may
        take, and its approximate size. It never sees names, numbers, usernames or contents. Others
        who relay your messages see the same about you.
      </Text>
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        Battery and storage
      </Text>
      <Text className="text-muted">
        Relaying keeps Bluetooth busy and stores up to 250 MB of other people&apos;s encrypted
        messages, kept apart from your chats. It pauses by itself on low battery, with the battery
        saver on or when storage runs low.
      </Text>
    </>
  );
}

function BackgroundLimits() {
  return (
    <>
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        When relaying stops
      </Text>
      <Text className="text-muted">{NEARBY_COPY[nearbyPlatform].relayBackground}</Text>
    </>
  );
}

export function NearbyRelayScreen() {
  const router = useRouter();
  const nearbyOn = useNearby((state) => state.enabled);
  const { prefs, decision, mesh, available } = useRelay();
  const text = describeRelay(decision, prefs, mesh.stored);

  useFocusEffect(
    useCallback(() => {
      void refreshNearby()
        .then(() => startNearby())
        .catch(() => undefined);
    }, []),
  );

  const switchRow = (
    title: string,
    value: boolean,
    onChange: (value: boolean) => void,
    subtitle?: string,
    disabled = false,
  ) => (
    <ListRow
      title={title}
      {...(subtitle ? { subtitle } : {})}
      {...(disabled ? {} : { onPress: () => onChange(!value) })}
      accessory={
        <Toggle
          accessibilityLabel={title}
          value={value}
          disabled={disabled}
          onValueChange={onChange}
        />
      }
    />
  );

  return (
    <Screen>
      <ListSection>
        {switchRow(
          'Allow this device to relay messages',
          prefs.enabled,
          (enabled) => save({ enabled }),
          text.title,
          !available,
        )}
      </ListSection>
      <Text
        accessibilityLiveRegion="polite"
        className={text.tone === 'warning' ? 'font-semibold text-danger' : 'text-muted'}
      >
        {available ? text.detail : 'Nearby relay is not available in this build.'}
      </Text>
      {!nearbyOn && (
        <ListSection>
          <ListRow
            title="Turn on nearby messaging"
            subtitle="Relaying uses the nearby connection"
            onPress={() => router.push('/nearby-messaging')}
          />
        </ListSection>
      )}

      {prefs.enabled && (
        <>
          <ListSection title="Pause relaying">
            {switchRow('Only while charging', prefs.onlyWhileCharging, (onlyWhileCharging) =>
              save({ onlyWhileCharging }),
            )}
            {switchRow('While the battery saver is on', prefs.pauseOnSaver, (pauseOnSaver) =>
              save({ pauseOnSaver }),
            )}
          </ListSection>
          <ListSection title="Pause below this battery level">
            {BATTERY_LEVELS.map((level) => (
              <ListRow
                key={level}
                title={`${level}%`}
                onPress={() => save({ minBatteryPercent: level })}
                accessory={
                  prefs.minBatteryPercent === level ? (
                    <Icon icon={CheckIcon} color="accent" />
                  ) : undefined
                }
              />
            ))}
          </ListSection>
          <ListSection title="Pause when free storage is below">
            {STORAGE_LEVELS.map((mb) => (
              <ListRow
                key={mb}
                title={formatSize(mb * 1_048_576)}
                onPress={() => save({ minFreeStorageMb: mb })}
                accessory={
                  prefs.minFreeStorageMb === mb ? (
                    <Icon icon={CheckIcon} color="accent" />
                  ) : undefined
                }
              />
            ))}
          </ListSection>
          <ListSection title="After a restart">
            {switchRow(
              'Remind me to turn it back on',
              prefs.remindAfterRestart,
              (remindAfterRestart) => save({ remindAfterRestart }),
              'A notification after the phone restarts; nearby starts again when you open PingDost',
            )}
          </ListSection>
        </>
      )}

      <ListSection title="Relay cache">
        <ListRow
          title={
            mesh.stored.packets === 0
              ? 'Empty'
              : `${mesh.stored.packets} encrypted ${mesh.stored.packets === 1 ? 'message' : 'messages'} · ${formatSize(mesh.stored.bytes)}`
          }
          subtitle={`Since PingDost started: ${mesh.carried} taken for others, ${mesh.handedOver} handed to their recipient`}
        />
        <ListRow
          title="Clear relay cache"
          subtitle="Deletes only messages carried for others. Your chats stay."
          {...(mesh.stored.packets > 0 ? { onPress: confirmClearRelay } : {})}
        />
      </ListSection>

      <RelayExplainer />
      <BackgroundLimits />
    </Screen>
  );
}
