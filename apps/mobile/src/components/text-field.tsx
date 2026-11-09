import { useState, type ReactNode } from 'react';
import { ActivityIndicator, View, type TextInputProps } from 'react-native';
import Animated from 'react-native-reanimated';

import { CSS_EASE_OUT, useMotion } from '@/theme/motion';
import { useTheme } from '@/theme/theme-root';

import { CheckIcon, CircleAlertIcon, Icon } from './icon';
import { Text, TextInput } from './text';

/** A status line under the field, e.g. a live check; an `error` wins over it. */
export interface FieldNote {
  tone: 'success' | 'danger' | 'muted';
  text: string;
  /** Shows a small spinner (a check in progress). */
  busy?: boolean;
}

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string;
  hint?: string;
  note?: FieldNote;
  /** A control inside the field, after the text (e.g. show/hide password). */
  trailing?: ReactNode;
}

const NOTE_TEXT = { success: 'text-success', danger: 'text-danger', muted: 'text-muted' } as const;

/** A labelled input with its error below; errors and notes are announced by screen readers. */
export function TextField({
  label,
  error,
  hint,
  note,
  trailing,
  onFocus,
  onBlur,
  ...input
}: TextFieldProps) {
  const { palette, prefs } = useTheme();
  const { fades } = useMotion();
  const [focused, setFocused] = useState(false);
  const flagged = error ?? (note?.tone === 'danger' ? note.text : undefined);
  const borderColor = flagged
    ? palette.danger
    : focused
      ? palette.accent
      : note?.tone === 'success'
        ? palette.success
        : prefs.look === 'sticker'
          ? palette.foreground
          : palette.border;
  return (
    <View className="gap-2">
      <Text className="px-1 font-bold text-foreground">{label}</Text>
      <Animated.View
        className="flex-row items-center rounded-lg bg-surface"
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
          className="min-h-[50px] flex-1 px-4 py-3 text-base text-foreground"
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
        {trailing && <View className="pr-1">{trailing}</View>}
      </Animated.View>
      {error ? (
        <Text accessibilityLiveRegion="polite" className="px-1 font-semibold text-danger">
          {error}
        </Text>
      ) : note ? (
        <View accessibilityLiveRegion="polite" className="flex-row items-center gap-2 px-1">
          {note.busy ? (
            <ActivityIndicator size="small" color={palette.muted} />
          ) : note.tone === 'success' ? (
            <Icon icon={CheckIcon} size={16} color="success" strokeWidth={3} />
          ) : note.tone === 'danger' ? (
            <Icon icon={CircleAlertIcon} size={16} color="danger" />
          ) : null}
          <Text className={`flex-1 font-semibold ${NOTE_TEXT[note.tone]}`}>{note.text}</Text>
        </View>
      ) : (
        hint && <Text className="px-1 text-muted">{hint}</Text>
      )}
    </View>
  );
}
