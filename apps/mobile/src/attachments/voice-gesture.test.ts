import { describe, expect, it } from 'vitest';

import {
  CANCEL_DISTANCE,
  isRecording,
  LOCK_DISTANCE,
  MIN_HOLD_MS,
  slideOffset,
  slideOutcome,
  VOICE_IDLE,
  voiceStep,
  type VoiceEvent,
  type VoiceState,
  type VoiceStep,
} from './voice-gesture';

/** Runs events from idle; returns every step. */
function run(...events: VoiceEvent[]): VoiceStep[] {
  const steps: VoiceStep[] = [];
  let state: VoiceState = VOICE_IDLE;
  for (const event of events) {
    const step = voiceStep(state, event);
    steps.push(step);
    state = step.state;
  }
  return steps;
}

function last(steps: VoiceStep[]): VoiceStep {
  const step = steps.at(-1);
  if (!step) throw new Error('no steps');
  return step;
}

const HOLD = { type: 'press', at: 10_000 } as const;
const LOCK = { type: 'slide', dx: -4, dy: -LOCK_DISTANCE } as const;

describe('voice note gesture', () => {
  it('press starts recording while held', () => {
    const [step] = run(HOLD);
    expect(step).toEqual({
      state: { phase: 'holding', pressedAt: 10_000 },
      effect: 'start',
      feedback: 'start',
    });
    expect(isRecording(step!.state)).toBe(true);
  });

  it('hold then release sends', () => {
    const step = last(run(HOLD, { type: 'release', at: 10_000 + MIN_HOLD_MS + 400 }));
    expect(step).toEqual({ state: VOICE_IDLE, effect: 'send' });
  });

  it('a short tap drops the recording and shows the hint', () => {
    const step = last(run(HOLD, { type: 'release', at: 10_000 + MIN_HOLD_MS - 1 }));
    expect(step).toEqual({ state: VOICE_IDLE, effect: 'discard', feedback: 'short' });
    // Exactly the minimum counts as a hold.
    expect(last(run(HOLD, { type: 'release', at: 10_000 + MIN_HOLD_MS })).effect).toBe('send');
  });

  it('sliding left past the line cancels, and the release after it does nothing', () => {
    const steps = run(
      HOLD,
      { type: 'slide', dx: -40, dy: 0 },
      { type: 'slide', dx: -CANCEL_DISTANCE, dy: -10 },
      { type: 'release', at: 20_000 },
    );
    expect(steps[1]).toEqual({ state: { phase: 'holding', pressedAt: 10_000 } });
    expect(steps[2]).toEqual({ state: VOICE_IDLE, effect: 'discard', feedback: 'bin' });
    expect(steps[3]).toEqual({ state: VOICE_IDLE });
  });

  it('sliding up onto the lock locks; lifting the finger then keeps recording', () => {
    const steps = run(HOLD, { type: 'slide', dx: 0, dy: -30 }, LOCK, {
      type: 'release',
      at: 30_000,
    });
    expect(steps[1]!.state.phase).toBe('holding');
    expect(steps[2]).toEqual({ state: { phase: 'locked', pressedAt: 10_000 }, feedback: 'lock' });
    expect(steps[3]).toEqual({ state: { phase: 'locked', pressedAt: 10_000 } });
    expect(isRecording(steps[3]!.state)).toBe(true);
  });

  it('a slide after locking does not cancel', () => {
    const step = last(run(HOLD, LOCK, { type: 'slide', dx: -200, dy: 0 }));
    expect(step.state.phase).toBe('locked');
    expect(step.effect).toBeUndefined();
  });

  it('lock → stop → review → send', () => {
    const steps = run(HOLD, LOCK, { type: 'stop' }, { type: 'send' });
    expect(steps[2]).toEqual({ state: { phase: 'review', pressedAt: 0 }, effect: 'review' });
    expect(isRecording(steps[2]!.state)).toBe(false);
    expect(steps[3]).toEqual({ state: VOICE_IDLE, effect: 'send' });
  });

  it('lock → stop → review → delete', () => {
    const step = last(run(HOLD, LOCK, { type: 'stop' }, { type: 'delete' }));
    expect(step).toEqual({ state: VOICE_IDLE, effect: 'discard', feedback: 'bin' });
  });

  it('lock → delete discards while recording', () => {
    const step = last(run(HOLD, LOCK, { type: 'delete' }));
    expect(step).toEqual({ state: VOICE_IDLE, effect: 'discard', feedback: 'bin' });
  });

  it('lock → send sends without review', () => {
    expect(last(run(HOLD, LOCK, { type: 'send' }))).toEqual({ state: VOICE_IDLE, effect: 'send' });
  });

  it('with a screen reader a tap records hands-free (the old tap-to-start flow)', () => {
    const steps = run({ type: 'tap' }, { type: 'send' });
    expect(steps[0]).toEqual({
      state: { phase: 'locked', pressedAt: 0 },
      effect: 'start',
      feedback: 'start',
    });
    expect(steps[1]).toEqual({ state: VOICE_IDLE, effect: 'send' });
    expect(last(run({ type: 'tap' }, { type: 'stop' })).state.phase).toBe('review');
  });

  it('an interruption drops a held recording', () => {
    expect(last(run(HOLD, { type: 'interrupt' }))).toEqual({
      state: VOICE_IDLE,
      effect: 'discard',
    });
  });

  it('an interruption sends a locked recording to review, and leaves review alone', () => {
    const steps = run(HOLD, LOCK, { type: 'interrupt' }, { type: 'interrupt' });
    expect(steps[2]).toEqual({ state: { phase: 'review', pressedAt: 0 }, effect: 'review' });
    expect(steps[3]).toEqual({ state: { phase: 'review', pressedAt: 0 } });
    expect(voiceStep(VOICE_IDLE, { type: 'interrupt' })).toEqual({ state: VOICE_IDLE });
  });

  it('a lost touch drops a held recording only', () => {
    expect(last(run(HOLD, { type: 'lost' }))).toEqual({ state: VOICE_IDLE, effect: 'discard' });
    expect(last(run(HOLD, LOCK, { type: 'lost' })).state.phase).toBe('locked');
  });

  it('a failure to record returns to idle from any phase', () => {
    expect(last(run(HOLD, { type: 'failed' }))).toEqual({ state: VOICE_IDLE, effect: 'discard' });
    expect(last(run({ type: 'tap' }, { type: 'failed' })).state).toEqual(VOICE_IDLE);
    expect(last(run(HOLD, LOCK, { type: 'stop' }, { type: 'failed' })).effect).toBe('discard');
    expect(voiceStep(VOICE_IDLE, { type: 'failed' })).toEqual({ state: VOICE_IDLE });
  });

  it('the length limit sends a held note and reviews a locked one', () => {
    expect(last(run(HOLD, { type: 'limit' }))).toEqual({ state: VOICE_IDLE, effect: 'send' });
    expect(last(run(HOLD, LOCK, { type: 'limit' })).effect).toBe('review');
  });

  it('events outside their phase change nothing', () => {
    const idle: VoiceEvent[] = [
      { type: 'release', at: 1 },
      { type: 'slide', dx: -500, dy: 0 },
      { type: 'stop' },
      { type: 'send' },
      { type: 'delete' },
      { type: 'lost' },
      { type: 'limit' },
    ];
    for (const event of idle) expect(voiceStep(VOICE_IDLE, event)).toEqual({ state: VOICE_IDLE });
    const holding = last(run(HOLD)).state;
    for (const event of [{ type: 'stop' }, { type: 'send' }, { type: 'delete' }] as const) {
      expect(voiceStep(holding, event)).toEqual({ state: holding });
    }
    const locked = last(run(HOLD, LOCK)).state;
    expect(voiceStep(locked, HOLD)).toEqual({ state: locked });
    expect(voiceStep(locked, { type: 'tap' })).toEqual({ state: locked });
  });
});

describe('slide thresholds', () => {
  it('the further direction wins', () => {
    expect(slideOutcome(0, 0)).toBe('none');
    expect(slideOutcome(-CANCEL_DISTANCE + 1, 0)).toBe('none');
    expect(slideOutcome(-CANCEL_DISTANCE, 0)).toBe('cancel');
    expect(slideOutcome(0, -LOCK_DISTANCE)).toBe('lock');
    // Diagonal: more left than up never locks, more up than left never cancels.
    expect(slideOutcome(-CANCEL_DISTANCE - 20, -LOCK_DISTANCE - 10)).toBe('cancel');
    expect(slideOutcome(-CANCEL_DISTANCE + 5, -CANCEL_DISTANCE)).toBe('lock');
    // Right and down do nothing.
    expect(slideOutcome(300, 300)).toBe('none');
  });

  it('the microphone follows one axis and stops at the line', () => {
    expect(slideOffset(-40, -10)).toEqual({ x: -40, y: 0 });
    expect(slideOffset(-500, 0)).toEqual({ x: -CANCEL_DISTANCE, y: 0 });
    expect(slideOffset(-10, -60)).toEqual({ x: 0, y: -60 });
    expect(slideOffset(0, -500)).toEqual({ x: 0, y: -LOCK_DISTANCE });
    expect(slideOffset(50, 0)).toEqual({ x: 0, y: 0 });
    expect(slideOffset(0, 80)).toEqual({ x: 0, y: 0 });
  });
});
