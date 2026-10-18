import { describe, expect, it } from 'vitest';

import {
  canTransition,
  MESSAGE_STATE_TRANSITIONS,
  MessageStateSchema,
  type MessageState,
} from './message-state';

const states = MessageStateSchema.options;

function reachable(from: MessageState): Set<MessageState> {
  const seen = new Set<MessageState>();
  const queue = [from];
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    for (const next of MESSAGE_STATE_TRANSITIONS[state]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe('MessageState', () => {
  it('names exactly the REQ §8.3 states', () => {
    expect(states).toEqual([
      'local_queued',
      'sending',
      'sent_to_server',
      'waiting_for_nearby_route',
      'relayed',
      'delivered_to_recipient_device',
      'read',
      'expired_undelivered',
      'failed',
    ]);
  });

  it('has a transition list for every state, without self-transitions or duplicates', () => {
    expect(Object.keys(MESSAGE_STATE_TRANSITIONS).sort()).toEqual([...states].sort());
    for (const state of states) {
      const targets = MESSAGE_STATE_TRANSITIONS[state];
      expect(targets).not.toContain(state);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it('never treats server or relay acceptance as delivery', () => {
    expect(canTransition('sent_to_server', 'relayed')).toBe(false);
    expect(canTransition('relayed', 'sent_to_server')).toBe(false);
    expect(canTransition('delivered_to_recipient_device', 'sent_to_server')).toBe(false);
    expect(canTransition('delivered_to_recipient_device', 'relayed')).toBe(false);
  });

  it('makes read terminal and delivery reachable until then', () => {
    expect(MESSAGE_STATE_TRANSITIONS.read).toEqual([]);
    for (const state of states.filter(
      (s) => s !== 'read' && s !== 'delivered_to_recipient_device',
    )) {
      expect(reachable(state).has('delivered_to_recipient_device'), state).toBe(true);
    }
  });

  it('allows the expected paths', () => {
    const path = (...steps: MessageState[]) =>
      steps.every((state, i) => i === 0 || canTransition(steps[i - 1] as MessageState, state));
    expect(
      path('local_queued', 'sending', 'sent_to_server', 'delivered_to_recipient_device', 'read'),
    ).toBe(true);
    expect(
      path('local_queued', 'waiting_for_nearby_route', 'relayed', 'delivered_to_recipient_device'),
    ).toBe(true);
    expect(path('local_queued', 'sending', 'failed', 'sending', 'sent_to_server')).toBe(true);
    expect(path('sent_to_server', 'expired_undelivered', 'delivered_to_recipient_device')).toBe(
      true,
    );
    expect(path('read', 'delivered_to_recipient_device')).toBe(false);
  });
});
