import { Text, View } from 'react-native';

import { Screen } from '@/components/screen';

function Section({ title, children }: { title: string; children: string }) {
  return (
    <View className="gap-1">
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        {title}
      </Text>
      <Text className="text-base text-foreground">{children}</Text>
    </View>
  );
}

/** The privacy promise in plain words (REQ §1, §5.4; ARCHITECTURE A10). */
export function AboutPrivacyScreen() {
  return (
    <Screen title="About privacy">
      <Section title="Your chats live on your devices">
        PingDost keeps no permanent server-side chat history. Your conversation history is stored on
        your own devices, in an encrypted database.
      </Section>
      <Section title="What passes through our servers">
        Messages and attachments are end-to-end encrypted before they leave your phone. When the
        person you write to is offline, our servers hold the encrypted message for a limited time to
        deliver it, then delete it once their device confirms it arrived, or when the retention
        period runs out. We cannot read these messages.
      </Section>
      <Section title="What we do store">
        Your account (username, verified email, and a password hash if you use a password), your
        settings, and your devices with their public keys. Private keys never leave your devices. To
        deliver messages, our servers also see who is sending to whom, when, and how large a message
        is.
      </Section>
      <Section title="What deletion cannot reach">
        Deleting a message cannot erase screenshots, exports, notifications already shown, or copies
        kept on the other person&apos;s devices.
      </Section>
    </Screen>
  );
}
