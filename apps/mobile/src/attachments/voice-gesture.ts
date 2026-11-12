// Voice notes by hold and slide (Phase 40): the gesture as a pure state machine. The composer
// feeds it touch and button events and runs the effect each step returns; nothing here touches
// the microphone, the clock or the screen.
//
//   idle ──press──▶ holding ──release (≥ MIN_HOLD_MS)──▶ idle + send
//                      │ ├──release (shorter)─────────▶ idle + discard, "Hold to record"
//                      │ ├──slide left─────────────────▶ idle + discard (bin)
//                      │ └──slide up───────────────────▶ locked
//   idle ──tap (screen reader)─────────────────────────▶ locked
//   locked ──stop──▶ review;  locked/review ──send──▶ idle + send;  ──delete──▶ idle + discard

/** Shorter holds count as a tap: nothing is sent and a hint explains the gesture. */
export const MIN_HOLD_MS = 1_000;
/** Sliding this far left cancels. */
export const CANCEL_DISTANCE = 110;
/** Sliding this far up locks. */
export const LOCK_DISTANCE = 90;
/** Long enough for any voice note; far under the size limit. */
export const MAX_RECORDING_MS = 15 * 60_000;
/** Recordings shorter than this are never sent (a stray tap in the locked or screen-reader flow). */
export const MIN_NOTE_MS = 500;

export type VoicePhase = 'idle' | 'holding' | 'locked' | 'review';

export interface VoiceState {
  phase: VoicePhase;
  /** When the finger went down (`holding` only). */
  pressedAt: number;
}

export const VOICE_IDLE: VoiceState = { phase: 'idle', pressedAt: 0 };

export type VoiceEvent =
  /** The finger went down on the microphone. */
  | { type: 'press'; at: number }
  /** With a screen reader on, a tap starts recording, hands-free from the start. */
  | { type: 'tap' }
  /** The finger moved, from where it went down (left and up are negative). */
  | { type: 'slide'; dx: number; dy: number }
  /** The finger lifted. */
  | { type: 'release'; at: number }
  /** The system took the touch away before the finger lifted. */
  | { type: 'lost' }
  /** Recording could not start (no permission, microphone busy), or produced nothing usable. */
  | { type: 'failed' }
  /** The Stop button: end the recording and listen to it. */
  | { type: 'stop' }
  | { type: 'send' }
  | { type: 'delete' }
  /** The app or the chat lost the screen, or a call came in. */
  | { type: 'interrupt' }
  /** The recording reached MAX_RECORDING_MS. */
  | { type: 'limit' };

/**
 * What the composer must do. `start`: open the microphone and record. `send` and `discard`: stop
 * recording if it still runs, then send or delete the note (in review: the reviewed note).
 * `review`: stop recording, keep the file and offer it for listening.
 */
export type VoiceEffect = 'start' | 'send' | 'discard' | 'review';

/** What just happened, for the haptic and the animation. `short`: the "Hold to record" hint. */
export type VoiceFeedback = 'start' | 'lock' | 'bin' | 'short';

export interface VoiceStep {
  state: VoiceState;
  effect?: VoiceEffect;
  feedback?: VoiceFeedback;
}

/**
 * Where a slide has got to. Whichever way the finger went further wins, so a diagonal drag never
 * does both. A worklet: the gesture checks it on the UI thread each frame and tells the machine
 * only when the answer changes.
 */
export function slideOutcome(dx: number, dy: number): 'none' | 'cancel' | 'lock' {
  'worklet';
  const left = -dx;
  const up = -dy;
  if (left >= up) return left >= CANCEL_DISTANCE ? 'cancel' : 'none';
  return up >= LOCK_DISTANCE ? 'lock' : 'none';
}

/** How far the microphone follows the finger: along one axis only, and never past the line. */
export function slideOffset(dx: number, dy: number): { x: number; y: number } {
  'worklet';
  if (-dx >= -dy) return { x: Math.max(-CANCEL_DISTANCE, Math.min(0, dx)), y: 0 };
  return { x: 0, y: Math.max(-LOCK_DISTANCE, Math.min(0, dy)) };
}

/** True while the microphone is open. */
export function isRecording(state: VoiceState): boolean {
  return state.phase === 'holding' || state.phase === 'locked';
}

export function voiceStep(state: VoiceState, event: VoiceEvent): VoiceStep {
  const stay: VoiceStep = { state };
  const { phase } = state;
  switch (event.type) {
    case 'press':
      if (phase !== 'idle') return stay;
      return {
        state: { phase: 'holding', pressedAt: event.at },
        effect: 'start',
        feedback: 'start',
      };
    case 'tap':
      if (phase !== 'idle') return stay;
      return { state: { phase: 'locked', pressedAt: 0 }, effect: 'start', feedback: 'start' };
    case 'slide': {
      if (phase !== 'holding') return stay;
      const outcome = slideOutcome(event.dx, event.dy);
      if (outcome === 'cancel') return { state: VOICE_IDLE, effect: 'discard', feedback: 'bin' };
      if (outcome === 'lock') {
        return { state: { phase: 'locked', pressedAt: state.pressedAt }, feedback: 'lock' };
      }
      return stay;
    }
    case 'release':
      if (phase !== 'holding') return stay;
      if (event.at - state.pressedAt < MIN_HOLD_MS) {
        return { state: VOICE_IDLE, effect: 'discard', feedback: 'short' };
      }
      return { state: VOICE_IDLE, effect: 'send' };
    case 'lost':
      return phase === 'holding' ? { state: VOICE_IDLE, effect: 'discard' } : stay;
    case 'failed':
      return phase === 'idle' ? stay : { state: VOICE_IDLE, effect: 'discard' };
    case 'stop':
      return phase === 'locked'
        ? { state: { phase: 'review', pressedAt: 0 }, effect: 'review' }
        : stay;
    case 'send':
      return phase === 'locked' || phase === 'review'
        ? { state: VOICE_IDLE, effect: 'send' }
        : stay;
    case 'delete':
      return phase === 'locked' || phase === 'review'
        ? { state: VOICE_IDLE, effect: 'discard', feedback: 'bin' }
        : stay;
    case 'interrupt':
      // A held recording needs the finger, which has gone: drop it. A locked one is kept.
      if (phase === 'holding') return { state: VOICE_IDLE, effect: 'discard' };
      if (phase === 'locked') return { state: { phase: 'review', pressedAt: 0 }, effect: 'review' };
      return stay;
    case 'limit':
      // As if the finger lifted, or Stop was pressed.
      if (phase === 'holding') return { state: VOICE_IDLE, effect: 'send' };
      if (phase === 'locked') return { state: { phase: 'review', pressedAt: 0 }, effect: 'review' };
      return stay;
  }
}
