/** Every state × event of the call state machine (REQ §12.2). */
import { describe, expect, it } from 'vitest';

import {
  isLive,
  isUnanswered,
  transition,
  type CallContext,
  type CallEvent,
  type CallState,
  type Transition,
} from './machine';

const STATES: CallState[] = [
  'idle',
  'outgoing',
  'incoming',
  'ringing',
  'connecting',
  'connected',
  'reconnecting',
  'ended',
];

const EVENTS: CallEvent[] = [
  { type: 'dial' },
  { type: 'invite' },
  { type: 'ringing' },
  { type: 'accept' },
  { type: 'answer' },
  { type: 'connected' },
  { type: 'disconnected' },
  { type: 'hangup_local' },
  { type: 'hangup_remote' },
  { type: 'hangup_remote', reason: 'normal' },
  { type: 'hangup_remote', reason: 'answered_elsewhere' },
  { type: 'hangup_remote', reason: 'declined_elsewhere' },
  { type: 'hangup_remote', reason: 'no_answer' },
  { type: 'hangup_remote', reason: 'failed' },
  { type: 'hangup_remote', reason: 'replaced' },
  { type: 'reject_local' },
  { type: 'reject_remote' },
  { type: 'busy_remote' },
  { type: 'ring_timeout' },
  { type: 'failure' },
  { type: 'dismissed' },
];

function key(event: CallEvent): string {
  return event.type === 'hangup_remote' ? `hangup_remote:${event.reason ?? '-'}` : event.type;
}

const go = (state: CallState): Transition => ({ state });
const end = (outcome: NonNullable<Transition['outcome']>): Transition => ({
  state: 'ended',
  outcome,
});

/**
 * The expected result for a caller ('out') or callee ('in') that never connected; anything
 * not listed must be ignored (undefined).
 */
function expected(state: CallState, direction: 'in' | 'out'): Record<string, Transition> {
  const remoteNormal =
    state === 'incoming' || direction === 'in' ? end('missed') : end('cancelled');
  const live = {
    hangup_local: state === 'incoming' ? end('rejected') : end('cancelled'),
    'hangup_remote:-': remoteNormal,
    'hangup_remote:normal': remoteNormal,
    'hangup_remote:failed': end('failed'),
    failure: end('failed'),
  };
  switch (state) {
    case 'idle':
    case 'ended':
      return { dial: go('outgoing'), invite: go('incoming') };
    case 'outgoing':
      return {
        ...live,
        ringing: go('ringing'),
        answer: go('connecting'),
        reject_remote: end('rejected'),
        busy_remote: end('busy'),
        ring_timeout: end('no_answer'),
        'hangup_remote:replaced': end('cancelled'),
      };
    case 'ringing':
      return {
        ...live,
        answer: go('connecting'),
        reject_remote: end('rejected'),
        busy_remote: end('busy'),
        ring_timeout: end('no_answer'),
        'hangup_remote:replaced': end('cancelled'),
      };
    case 'incoming':
      return {
        ...live,
        accept: go('connecting'),
        reject_local: end('rejected'),
        ring_timeout: end('missed'),
        dismissed: end('answered_elsewhere'),
        'hangup_remote:answered_elsewhere': end('answered_elsewhere'),
        'hangup_remote:declined_elsewhere': end('declined_elsewhere'),
        'hangup_remote:no_answer': end('missed'),
        'hangup_remote:replaced': end('cancelled'),
      };
    case 'connecting':
      return { ...live, connected: go('connected') };
    case 'connected':
      return { ...live, disconnected: go('reconnecting') };
    case 'reconnecting':
      return { ...live, connected: go('connected') };
  }
}

describe('call state machine', () => {
  for (const direction of ['in', 'out'] as const) {
    for (const state of STATES) {
      it(`${direction}: ${state} handles every event as specified`, () => {
        const table = expected(state, direction);
        const context: CallContext = { state, direction, everConnected: false };
        for (const event of EVENTS) {
          expect(transition(context, event), `${state} + ${key(event)}`).toEqual(table[key(event)]);
        }
      });
    }
  }

  it('ends a call that was connected as completed, whoever hangs up', () => {
    for (const state of ['connected', 'reconnecting', 'connecting'] as const) {
      for (const direction of ['in', 'out'] as const) {
        const context: CallContext = { state, direction, everConnected: true };
        expect(transition(context, { type: 'hangup_local' })).toEqual(end('completed'));
        expect(transition(context, { type: 'hangup_remote', reason: 'normal' })).toEqual(
          end('completed'),
        );
        expect(transition(context, { type: 'failure' })).toEqual(end('failed'));
      }
    }
  });

  it('classifies live and unanswered states', () => {
    expect(STATES.filter(isLive)).toEqual([
      'outgoing',
      'incoming',
      'ringing',
      'connecting',
      'connected',
      'reconnecting',
    ]);
    expect(STATES.filter(isUnanswered)).toEqual(['outgoing', 'incoming', 'ringing']);
  });
});
