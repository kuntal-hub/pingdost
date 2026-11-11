// Where the reader is in a chat, the same on the phone and the web (Phase 36): whether they are
// at the newest message, and how many messages arrived while they read older ones.
import type { TimelineItem } from './timeline';

/** This close to the end (px) still counts as reading the newest message. */
export const AT_END_PX = 64;

/** Whether the list is scrolled to (or within `slack` of) its end. */
export function isAtEnd(
  offset: number,
  viewport: number,
  content: number,
  slack: number = AT_END_PX,
): boolean {
  // A list shorter than its viewport is always at its end.
  return content - offset - viewport <= slack;
}

/** The newest message the reader had seen when they scrolled away from the end. */
export interface SeenMark {
  key: string;
  sortAt: number;
}

/** The newest message in the timeline, to remember when the reader leaves the end. */
export function newestMark(items: readonly TimelineItem[]): SeenMark | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === 'message') return { key: item.key, sortAt: item.message.sortAt };
  }
  return undefined;
}

/**
 * Messages from others that arrived after `seen`: the count on the "new messages" pill. Own
 * messages (other devices, too) and notices are not counted.
 */
export function unseenCount(items: readonly TimelineItem[], seen: SeenMark | undefined): number {
  if (!seen) return 0;
  let count = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== 'message') continue;
    if (item.key === seen.key || item.message.sortAt < seen.sortAt) break;
    if (item.message.direction === 'in' && item.message.kind !== 'system') count += 1;
  }
  return count;
}

/** "1 new message", "2 new messages"; "99+" past 99. */
export function unseenLabel(count: number): string {
  const shown = count > 99 ? '99+' : String(count);
  return `${shown} new message${count === 1 ? '' : 's'}`;
}
