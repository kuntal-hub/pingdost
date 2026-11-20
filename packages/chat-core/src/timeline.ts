// The chat timeline: messages oldest first, with a day separator before each new day.
import type { MessageRecord } from '@pingdost/message-engine';

export type TimelineItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'message'; key: string; message: MessageRecord };

function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// Formatters are made once: `toLocale…String` builds a new one on every call, which costs about
// 1 ms on a phone (Hermes), twice per message bubble (ADR 0047).
let formats:
  { time: Intl.DateTimeFormat; day: Intl.DateTimeFormat; dayYear: Intl.DateTimeFormat } | undefined;

function formatters() {
  formats ??= {
    time: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }),
    day: new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' }),
    dayYear: new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
  };
  return formats;
}

/** "Today", "Yesterday", or the date in the device's locale. */
export function dayLabel(ms: number, now = Date.now()): string {
  if (dayKey(ms) === dayKey(now)) return 'Today';
  if (dayKey(ms) === dayKey(now - 86_400_000)) return 'Yesterday';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? formatters().day : formatters().dayYear).format(ms);
}

export function timeLabel(ms: number): string {
  return formatters().time.format(ms);
}

/** Messages (any order, duplicates allowed) → the sorted timeline with day separators. */
export function buildTimeline(
  messages: readonly MessageRecord[],
  now = Date.now(),
): TimelineItem[] {
  const unique = new Map(messages.map((m) => [m.messageId, m]));
  const sorted = [...unique.values()].sort(
    (a, b) => a.sortAt - b.sortAt || (a.messageId < b.messageId ? -1 : 1),
  );
  const items: TimelineItem[] = [];
  let lastDay: string | undefined;
  for (const message of sorted) {
    const day = dayKey(message.sortAt);
    if (day !== lastDay) {
      items.push({ type: 'day', key: `day:${day}`, label: dayLabel(message.sortAt, now) });
      lastDay = day;
    }
    items.push({ type: 'message', key: message.messageId, message });
  }
  return items;
}
