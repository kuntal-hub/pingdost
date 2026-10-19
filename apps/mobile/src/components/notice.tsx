import { Text, View } from 'react-native';

type Tone = 'error' | 'info' | 'success';

const tones: Record<Tone, { border: string; text: string }> = {
  error: { border: 'border-danger', text: 'text-danger' },
  info: { border: 'border-border', text: 'text-foreground' },
  success: { border: 'border-success', text: 'text-success' },
};

/** A short message box; errors and results are announced by screen readers. */
export function Notice({ message, tone = 'info' }: { message: string; tone?: Tone }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      className={`rounded-md border bg-surface px-4 py-3 ${tones[tone].border}`}
    >
      <Text className={tones[tone].text}>{message}</Text>
    </View>
  );
}
