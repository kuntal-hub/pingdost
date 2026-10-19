import { describe, expect, it } from 'vitest';

import {
  MESSAGE_STATE_TRANSITIONS,
  MessageStateSchema,
  type MessageState,
} from '@pingdost/shared-types';

import { advance, aggregateState, nextMessageState } from './states';
import type { DeliveryRecord } from './store';

function row(
  state: MessageState,
  own = false,
  deviceId = `${state}-${String(own)}`,
): DeliveryRecord {
  return { messageId: 'm', deviceId, userId: own ? 'me' : 'peer', own, state, updatedAt: 0 };
}

describe('aggregateState', () => {
  it('keeps the message state while no recipient device is known', () => {
    expect(aggregateState('local_queued', [])).toBe('local_queued');
    // Own devices never count, even when they have it.
    expect(aggregateState('sending', [row('delivered_to_recipient_device', true)])).toBe('sending');
  });

  it('shows the best state among the recipient devices', () => {
    expect(aggregateState('sending', [row('local_queued'), row('sent_to_server')])).toBe(
      'sent_to_server',
    );
    expect(
      aggregateState('sent_to_server', [
        row('sent_to_server'),
        row('delivered_to_recipient_device'),
      ]),
    ).toBe('delivered_to_recipient_device');
    expect(aggregateState('delivered_to_recipient_device', [row('read'), row('failed')])).toBe(
      'read',
    );
    expect(aggregateState('sending', [row('failed'), row('failed', false, 'other')])).toBe(
      'failed',
    );
  });

  it('keeps an expired message expired until a receipt arrives', () => {
    expect(aggregateState('expired_undelivered', [row('sent_to_server')])).toBe(
      'expired_undelivered',
    );
    expect(aggregateState('expired_undelivered', [row('delivered_to_recipient_device')])).toBe(
      'delivered_to_recipient_device',
    );
  });
});

describe('advance', () => {
  it('follows only legal transitions, allowing a skipped `sending` step', () => {
    expect(advance('local_queued', 'sending')).toBe('sending');
    expect(advance('local_queued', 'sent_to_server')).toBe('sent_to_server');
    expect(advance('read', 'delivered_to_recipient_device')).toBe('read');
    expect(advance('sent_to_server', 'local_queued')).toBe('sent_to_server');
    expect(advance('delivered_to_recipient_device', 'expired_undelivered')).toBe(
      'delivered_to_recipient_device',
    );
  });

  it('never produces a state the transition table forbids', () => {
    for (const from of MessageStateSchema.options) {
      for (const to of MessageStateSchema.options) {
        const next = advance(from, to);
        if (next === from) continue;
        const direct = MESSAGE_STATE_TRANSITIONS[from].includes(next);
        const viaSending =
          MESSAGE_STATE_TRANSITIONS[from].includes('sending') &&
          MESSAGE_STATE_TRANSITIONS.sending.includes(next);
        expect(direct || viaSending, `${from} → ${next}`).toBe(true);
      }
    }
  });

  it('never moves backwards from a receipt', () => {
    expect(nextMessageState('read', [row('sent_to_server')])).toBe('read');
    expect(nextMessageState('delivered_to_recipient_device', [row('local_queued')])).toBe(
      'delivered_to_recipient_device',
    );
  });
});
