import { useState } from 'react';
import { View, type TextInputProps } from 'react-native';
import Animated from 'react-native-reanimated';

import { CSS_EASE_OUT, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';

import { Text, TextInput } from './text';

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string;
  hint?: string;
}

/** A labelled input with its error below; the error is announced by screen readers. */
export function TextField({ label, error, hint, onFocus, onBlur, ...input }: TextFieldProps) {
  const { palette, prefs } = useTheme();
  const { fades } = useMotion();
  const [focused, setFocused] = useState(false);
  const borderColor = error
    ? palette.danger
    : focused
      ? palette.accent
      : prefs.look === 'sticker'
        ? palette.foreground
        : palette.border;
  return (
    <View className="gap-2">
      <Text className="px-1 font-bold text-foreground">{label}</Text>
      <Animated.View
        className="rounded-lg bg-surface"
        style={{
          borderWidth: 2,
          borderColor,
          ...(fades
            ? {
                transitionProperty: 'borderColor',
                transitionDuration: 150,
                transitionTimingFunction: CSS_EASE_OUT,
              }
            : {}),
        }}
      >
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={hint}
          className="min-h-[50px] px-4 py-3 text-base text-foreground"
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          {...input}
        />
      </Animated.View>
      {error ? (
        <Text accessibilityLiveRegion="polite" className="px-1 font-semibold text-danger">
          {error}
        </Text>
      ) : (
        hint && <Text className="px-1 text-muted">{hint}</Text>
      )}
    </View>
  );
}
