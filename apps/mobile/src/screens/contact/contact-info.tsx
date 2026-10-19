import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { QrCode } from '@/components/qr-code';
import { Screen } from '@/components/screen';
import { useBlocks, useIsBlocked } from '@/engine/blocks';
import { contactName } from '@/engine/contacts';
import { useContact } from '@/engine/hooks';
import { useSafetyNumber } from '@/engine/safety';
import { usePalette } from '@/theme/theme-root';
import { encodeSafetyQr } from '@pingdost/protocol/safety-number';

/** Profile, verification state, safety number and QR code; block and report. */
export function ContactInfoScreen({ userId }: { userId: string }) {
  const router = useRouter();
  const palette = usePalette();
  const contact = useContact(userId);
  const safety = useSafetyNumber(userId);
  const name = contactName(contact);
  const blocked = useIsBlocked(userId);
  const [busy, setBusy] = useState(false);

  function change(block: boolean) {
    setBusy(true);
    const blocks = useBlocks.getState();
    (block ? blocks.block(userId) : blocks.unblock(userId))
      .catch(() =>
        Alert.alert(
          block ? 'Could not block' : 'Could not unblock',
          'Check your connection and try again.',
        ),
      )
      .finally(() => setBusy(false));
  }

  function toggleBlock() {
    if (blocked) {
      change(false);
      return;
    }
    Alert.alert(
      `Block ${name}?`,
      `${name} won't be able to message you, see when you're online or see you typing. They aren't told: their messages still look sent to them. You can unblock them any time.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Block', style: 'destructive', onPress: () => change(true) },
      ],
    );
  }

  return (
    <Screen>
      <View className="items-center gap-2">
        <Avatar url={contact?.avatarUrl} name={name} size={88} />
        <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
          {name}
        </Text>
        {contact?.displayName && contact.username && (
          <Text className="text-muted">@{contact.username}</Text>
        )}
      </View>

      {safety.verified ? (
        <Notice tone="success" message={`✓ Verified. You compared safety numbers with ${name}.`} />
      ) : (
        <Notice
          message={`Not verified. Meet ${name} and scan each other's code to confirm no one is in between.`}
        />
      )}

      <View className="gap-3 rounded-lg border border-border bg-surface p-4">
        <Text accessibilityRole="header" className="font-semibold text-foreground">
          Safety number
        </Text>
        {safety.number ? (
          <View
            accessible
            accessibilityLabel={`Safety number: ${safety.number.groups.join(' ')}`}
            className="flex-row flex-wrap justify-between gap-y-2"
          >
            {safety.number.groups.map((group, index) => (
              <Text
                key={index}
                className="w-[24%] text-center text-lg text-foreground"
                style={{ fontFamily: 'monospace', letterSpacing: 1 }}
              >
                {group}
              </Text>
            ))}
          </View>
        ) : safety.problem === 'loading' ? (
          <ActivityIndicator color={palette.primary} />
        ) : (
          <Text className="text-muted">
            {safety.problem === 'no_own_key'
              ? 'This phone does not hold your account identity key, so it cannot show a safety number.'
              : `${name} has no identity key yet. It appears once they set up their phone.`}
          </Text>
        )}
        <Text className="text-muted">
          The same 60 digits appear on {name}&apos;s phone. If they differ, someone may be
          intercepting your messages. The number changes only when one of you sets up PingDost
          again.
        </Text>
      </View>

      {safety.number && (
        <View className="items-center gap-3">
          <QrCode
            value={encodeSafetyQr(safety.number)}
            size={220}
            accessibilityLabel={`Your safety code for ${name}. Let them scan it.`}
          />
          <Text className="text-center text-muted">
            Let {name} scan this code with their phone.
          </Text>
          <Button
            label={`Scan ${name}'s code`}
            onPress={() => router.push({ pathname: '/scan/[userId]', params: { userId } })}
          />
        </View>
      )}

      <View className="gap-3 border-t border-border pt-4">
        <Button
          label={blocked ? `Unblock ${name}` : `Block ${name}`}
          variant={blocked ? 'secondary' : 'danger'}
          loading={busy}
          onPress={toggleBlock}
        />
        <Button
          label={`Report ${name}`}
          variant="ghost"
          onPress={() => router.push({ pathname: '/report/[userId]', params: { userId } })}
        />
      </View>
    </Screen>
  );
}
