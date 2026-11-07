import { View } from 'react-native';

import { Screen } from '@/components/screen';
import { Text } from '@/components/text';
import { PRIVACY_EXPLAINER } from '@pingdost/chat-core';

/**
 * The privacy explainer in plain words (REQ §1, §5.4; ARCHITECTURE A10). The text is shared
 * with the web (`@pingdost/chat-core`, Phase 27) and follows docs/legal/privacy-policy.md.
 */
export function AboutPrivacyScreen() {
  return (
    <Screen>
      {PRIVACY_EXPLAINER.map(({ title, body }) => (
        <View key={title} className="gap-1">
          <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
            {title}
          </Text>
          <Text className="text-base text-foreground">{body}</Text>
        </View>
      ))}
    </Screen>
  );
}
