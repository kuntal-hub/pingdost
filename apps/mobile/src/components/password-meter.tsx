import { View } from 'react-native';

import { passwordStrength } from '@/auth/password-strength';
import { useTheme } from '@/theme/theme-root';

import { Text } from './text';

const TONES = ['danger', 'danger', 'warning', 'success'] as const;

/**
 * Strength bars and the most useful tip under a new password (Phase 34). Advice only: the length
 * rule is the one the server enforces.
 */
export function PasswordMeter({
  password,
  username,
  email,
}: {
  password: string;
  username?: string;
  email?: string;
}) {
  const { palette } = useTheme();
  if (password === '') return null;
  const strength = passwordStrength(password, {
    ...(username ? { username } : {}),
    ...(email ? { email } : {}),
  });
  const color = palette[TONES[strength.score]];
  const tip = strength.tips[0];
  return (
    <View
      accessible
      accessibilityLabel={`Password strength: ${strength.label}.${tip ? ` ${tip}.` : ''}`}
      className="gap-1 px-1"
    >
      <View className="flex-row gap-1">
        {[1, 2, 3].map((bar) => (
          <View
            key={bar}
            className="flex-1 rounded-full"
            style={{
              height: 6,
              backgroundColor: bar <= strength.score ? color : palette.border,
            }}
          />
        ))}
      </View>
      <Text className="text-sm text-muted">
        <Text className="text-sm font-bold" style={{ color }}>
          {strength.label}
        </Text>
        {tip ? ` · ${tip}` : ''}
      </Text>
    </View>
  );
}
