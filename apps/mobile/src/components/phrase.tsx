// The 24-word recovery phrase on screen (ADR 0022): shown as numbered words that cannot be
// selected or copied, and typed back in one field with live checks. The keyboard is asked
// not to learn or suggest the words (`visible-password`, no autocorrect, no autofill).
import { Text, View } from 'react-native';

import { isPhraseWord, normalizePhrase, PHRASE_WORDS, suggestWords } from '@pingdost/backup';

import { TextField } from './text-field';

export function PhraseGrid({ words }: { words: readonly string[] }) {
  return (
    <View
      accessible
      accessibilityLabel={`Recovery phrase: ${words.map((w, i) => `${i + 1}, ${w}`).join('; ')}`}
      className="flex-row flex-wrap rounded-md border border-border bg-surface p-2"
    >
      {words.map((word, index) => (
        <View key={index} className="w-1/3 flex-row items-baseline gap-1 p-2">
          <Text className="w-6 text-right text-muted">{index + 1}</Text>
          <Text selectable={false} className="text-base font-semibold text-foreground">
            {word}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Inputs that must never be learned by the keyboard or offered to autofill. */
export const SECRET_INPUT = {
  autoCapitalize: 'none',
  autoCorrect: false,
  autoComplete: 'off',
  importantForAutofill: 'no',
  keyboardType: 'visible-password',
  spellCheck: false,
  contextMenuHidden: true,
} as const;

/** What is wrong with typed phrase text, for the hint under the field (null when it looks right). */
export function phraseProblem(text: string): string | null {
  const words = normalizePhrase(text);
  const unknown = words.filter((w) => !isPhraseWord(w));
  if (unknown.length > 0) {
    const last = unknown.at(-1)!;
    const suggestions = suggestWords(last);
    return suggestions.length > 0
      ? `“${last}” is not a phrase word. Did you mean ${suggestions.join(', ')}?`
      : `“${last}” is not a phrase word.`;
  }
  if (words.length !== PHRASE_WORDS) return `${words.length} of ${PHRASE_WORDS} words`;
  return null;
}

export function PhraseInput({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (text: string) => void;
  error?: string;
}) {
  const problem = value.trim() ? phraseProblem(value) : null;
  return (
    <TextField
      label="Recovery phrase"
      hint={problem ?? 'Type the 24 words in order, separated by spaces.'}
      {...(error ? { error } : {})}
      value={value}
      onChangeText={onChange}
      multiline
      numberOfLines={4}
      textAlignVertical="top"
      {...SECRET_INPUT}
    />
  );
}
