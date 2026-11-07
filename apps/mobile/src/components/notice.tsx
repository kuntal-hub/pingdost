import { View } from 'react-native';

import { CheckIcon, CircleAlertIcon, Icon, InfoIcon, type LucideIcon } from './icon';
import { Text } from './text';

type Tone = 'error' | 'info' | 'success';

const tones: Record<
  Tone,
  { box: string; text: string; icon: LucideIcon; color: 'danger' | 'accent' | 'success' }
> = {
  error: { box: 'bg-danger/10', text: 'text-danger', icon: CircleAlertIcon, color: 'danger' },
  info: { box: 'bg-accent/10', text: 'text-foreground', icon: InfoIcon, color: 'accent' },
  success: { box: 'bg-success/10', text: 'text-success', icon: CheckIcon, color: 'success' },
};

/** A short message box; errors and results are announced by screen readers. */
export function Notice({ message, tone = 'info' }: { message: string; tone?: Tone }) {
  const { box, text, icon, color } = tones[tone];
  return (
    <View
      accessibilityLiveRegion="polite"
      className={`flex-row items-start gap-3 rounded-lg px-4 py-3 ${box}`}
    >
      <Icon icon={icon} size={20} color={color} />
      <Text className={`flex-1 font-semibold ${text}`}>{message}</Text>
    </View>
  );
}
