import { describe, expect, it } from 'vitest';

import { messageRecord } from '@pingdost/message-engine/testing';

import { isAtEnd, newestMark, unseenCount, unseenLabel } from './scroll';
import { buildTimeline } from './timeline';

const NOW = new Date(2026, 10, 10, 12).getTime();

function message(id: string, sortAt: number, direction: 'in' | 'out' = 'in', kind = 'text') {
  return messageRecord({
    messageId: id,
    sortAt,
    direction,
    kind: kind as 'text',
  });
}

describe('isAtEnd', () => {
  it('counts the last 64 px as the end', () => {
    expect(isAtEnd(1_000, 600, 1_600)).toBe(true);
    expect(isAtEnd(940, 600, 1_600)).toBe(true);
    expect(isAtEnd(930, 600, 1_600)).toBe(false);
    expect(isAtEnd(0, 600, 1_600)).toBe(false);
  });

  it('treats a list shorter than its viewport as at the end', () => {
    expect(isAtEnd(0, 600, 200)).toBe(true);
  });

  it('takes another slack', () => {
    expect(isAtEnd(520, 600, 1_600, 480)).toBe(true);
    expect(isAtEnd(400, 600, 1_600, 480)).toBe(false);
  });
});

describe('unseen messages', () => {
  const older = [message('a', NOW - 3_000), message('b', NOW - 2_000, 'out')];

  it('marks the newest message, skipping day separators', () => {
    const items = buildTimeline(older, NOW);
    expect(items[0]?.type).toBe('day');
    expect(newestMark(items)).toEqual({ key: 'b', sortAt: NOW - 2_000 });
    expect(newestMark([])).toBeUndefined();
  });

  it('counts only incoming messages after the mark', () => {
    const seen = newestMark(buildTimeline(older, NOW));
    const items = buildTimeline(
      [
        ...older,
        message('c', NOW - 1_000),
        message('d', NOW - 900, 'out'),
        message('e', NOW - 800, 'in', 'system'),
        message('f', NOW - 700),
      ],
      NOW,
    );
    expect(unseenCount(items, seen)).toBe(2);
    expect(unseenCount(items, undefined)).toBe(0);
    expect(unseenCount(buildTimeline(older, NOW), seen)).toBe(0);
  });

  it('stops at the mark’s time when the marked message is gone (deleted for me)', () => {
    const seen = { key: 'gone', sortAt: NOW - 2_500 };
    const items = buildTimeline([...older, message('c', NOW - 1_000)], NOW);
    expect(unseenCount(items, seen)).toBe(1);
  });

  it('counts across a new day', () => {
    const seen = { key: 'b', sortAt: NOW - 2_000 };
    const tomorrow = NOW + 86_400_000;
    const items = buildTimeline([...older, message('c', tomorrow)], tomorrow);
    expect(unseenCount(items, seen)).toBe(1);
  });

  it('labels the pill', () => {
    expect(unseenLabel(1)).toBe('1 new message');
    expect(unseenLabel(2)).toBe('2 new messages');
    expect(unseenLabel(120)).toBe('99+ new messages');
  });
});
