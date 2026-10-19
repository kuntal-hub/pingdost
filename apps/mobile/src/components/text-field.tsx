import { Text, TextInput, View, type TextInputProps } from 'react-native';

import { usePalette } from '@/theme/theme-root';

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string;
  hint?: string;
}

/** A labelled input with its error below; the error is announced by screen readers. */
export function TextField({ label, error, hint, ...input }: TextFieldProps) {
  const palette = usePalette();
  return (
    <View className="gap-1">
      <Text className="font-medium text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={palette.muted}
        className={`rounded-md border bg-surface px-3 py-3 text-base text-foreground ${
          error ? 'border-danger' : 'border-border'
        }`}
        {...input}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" className="text-danger">
          {error}
        </Text>
      ) : (
        hint && <Text className="text-muted">{hint}</Text>
      )}
    </View>
  );
}
