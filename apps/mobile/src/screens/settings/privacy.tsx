import { useEffect, useState } from 'react';
import { Switch, Text } from 'react-native';

import { describeError } from '@/api/errors';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { useAccount } from '@/settings/account';
import { usePalette } from '@/theme/theme-root';
import type { PrivacyPrefs } from '@pingdost/shared-types';

const options: { key: keyof PrivacyPrefs; title: string; subtitle: string }[] = [
  {
    key: 'readReceipts',
    title: 'Read receipts',
    subtitle: 'Let people see when you have read their messages.',
  },
  {
    key: 'typingIndicators',
    title: 'Typing indicator',
    subtitle: 'Let people see when you are typing.',
  },
  { key: 'lastSeen', title: 'Last seen', subtitle: 'Let people see when you were last online.' },
];

export function PrivacyScreen() {
  const palette = usePalette();
  const privacy = useAccount((state) => state.privacy);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void useAccount
      .getState()
      .load()
      .catch((caught: unknown) => setError(describeError(caught).message));
  }, []);

  async function toggle(key: keyof PrivacyPrefs, value: boolean): Promise<void> {
    const previous = useAccount.getState().privacy;
    if (!previous) return;
    setError(null);
    // Shown at once; put back if the server does not take it.
    useAccount.setState({ privacy: { ...previous, [key]: value } });
    try {
      await useAccount.getState().update({ privacy: { [key]: value } });
    } catch (caught) {
      useAccount.setState({ privacy: previous });
      setError(describeError(caught).message);
    }
  }

  return (
    <Screen offlineBanner>
      <ListSection>
        {options.map((option) => (
          <ListRow
            key={option.key}
            title={option.title}
            subtitle={option.subtitle}
            {...(privacy ? { onPress: () => void toggle(option.key, !privacy[option.key]) } : {})}
            accessory={
              <Switch
                accessibilityLabel={option.title}
                value={privacy?.[option.key] ?? false}
                disabled={!privacy}
                onValueChange={(value) => void toggle(option.key, value)}
                trackColor={{ true: palette.primary, false: palette.border }}
              />
            }
          />
        ))}
      </ListSection>
      {error && <Notice tone="error" message={error} />}
      <Text className="text-muted">
        These choices are saved with your account and on this phone. They take effect when chat
        arrives.
      </Text>
    </Screen>
  );
}
