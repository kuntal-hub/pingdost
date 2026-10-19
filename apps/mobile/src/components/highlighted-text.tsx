import { Text } from 'react-native';

import { highlightRanges } from '@pingdost/message-engine';

interface HighlightedTextProps {
  text: string;
  /** The search query; its matching words are emphasised. */
  query: string;
  numberOfLines?: number;
  className?: string;
}

/** Text with the words that matched a local search in bold, on a tinted background. */
export function HighlightedText({ text, query, numberOfLines, className }: HighlightedTextProps) {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const range of highlightRanges(text, query)) {
    if (range.start > at) parts.push({ text: text.slice(at, range.start), hit: false });
    parts.push({ text: text.slice(range.start, range.end), hit: true });
    at = range.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return (
    <Text numberOfLines={numberOfLines} className={className}>
      {parts.map((part, index) =>
        part.hit ? (
          <Text key={index} className="rounded bg-primary/20 font-bold text-foreground">
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}
