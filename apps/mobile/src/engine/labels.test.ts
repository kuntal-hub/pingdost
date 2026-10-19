import { describe, expect, it } from 'vitest';

import { messageRecord } from '@pingdost/message-engine/testing';
import { MessageStateSchema } from '@pingdost/shared-types';

import { stateLabel } from './labels';
import { buildTimeline, dayLabel } from './timeline';

describe('stateLabel', () => {
  it('never calls a server or relay hop delivered', () => {
    for (const state of MessageStateSchema.options) {
      const label = stateLabel(state, true);
      const delivered = /deliver/i.test(label.short) && !/before delivery/i.test(label.short);
      expect(delivered, state).toBe(state === 'delivered_to_recipient_device');
    }
    expect(stateLabel('sent_to_server', true).long).toContain('not yet delivered');
    expect(stateLabel('relayed', true).long).toContain('not yet delivered');
  });

  it('uses the REQ §11.6 wording', () => {
    expect(stateLabel('expired_undelivered', true).short).toBe('Expired before delivery');
    expect(stateLabel('waiting_for_nearby_route', false).long).toBe(
      'Queued on this device — waiting for a nearby route.',
    );
    expect(stateLabel('local_queued', false).long).toContain('waiting for a connection');
  });
});

describe('buildTimeline', () => {
  it('sorts, dedupes and separates days', () => {
    const now = new Date(2026, 9, 19, 12).getTime();
    const yesterday = now - 86_400_000;
    const a = messageRecord({ sortAt: yesterday });
    const b = messageRecord({ sortAt: now - 60_000 });
    const c = messageRecord({ sortAt: now });
    const items = buildTimeline([c, a, b, c], now);
    expect(items.map((i) => (i.type === 'day' ? i.label : i.message.messageId))).toEqual([
      'Yesterday',
      a.messageId,
      'Today',
      b.messageId,
      c.messageId,
    ]);
    expect(dayLabel(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
  });
});
