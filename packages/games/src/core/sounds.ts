// Game sounds made in code (ADR 0050): no sound files, nothing to license, the same on the phone
// and the web. Each sound is mono PCM in [-1, 1]; `encodeWav` wraps it for players that want a
// file (the phone). Deterministic: the same sound every time.
import { seededRandom } from './random';

export type GameSound = 'roll' | 'hop' | 'capture' | 'home' | 'win';
export const GAME_SOUNDS: readonly GameSound[] = ['roll', 'hop', 'capture', 'home', 'win'];
export const GAME_SOUND_RATE = 22_050;

/** One sound as samples in [-1, 1]. */
export function synthesizeGameSound(
  kind: GameSound,
  rate = GAME_SOUND_RATE,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.ceil(rate * DURATION[kind]));
  switch (kind) {
    case 'roll': {
      // The die rattling to a stop: knocks that come closer together and fade.
      const random = seededRandom(7);
      const knocks = [0, 0.065, 0.14, 0.205, 0.285, 0.35, 0.43, 0.5];
      knocks.forEach((at, i) => knock(out, rate, at, 0.9 - i * 0.09, random));
      break;
    }
    case 'hop':
      tone(out, rate, 0, 0.07, 540, 380, 0.55);
      break;
    case 'capture':
      tone(out, rate, 0, 0.32, 720, 170, 0.6, true);
      break;
    case 'home':
      tone(out, rate, 0, 0.12, 660, 660, 0.5);
      tone(out, rate, 0.11, 0.22, 990, 990, 0.5);
      break;
    case 'win':
      [523, 659, 784].forEach((hz, i) => tone(out, rate, i * 0.11, 0.13, hz, hz, 0.45));
      tone(out, rate, 0.33, 0.38, 1047, 1047, 0.5);
      break;
  }
  return normalize(out, 0.8);
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, rate = GAME_SOUND_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(clamped * 0x7fff), true);
  });
  return bytes;
}

const DURATION: Record<GameSound, number> = {
  roll: 0.56,
  hop: 0.08,
  capture: 0.34,
  home: 0.34,
  win: 0.72,
};

// A short noise burst through a one-pole low-pass, plus a woody tone: one knock of the die.
function knock(
  out: Float32Array,
  rate: number,
  at: number,
  gain: number,
  random: { next(): number },
): void {
  const start = Math.floor(at * rate);
  const length = Math.floor(0.035 * rate);
  let low = 0;
  for (let i = 0; i < length && start + i < out.length; i++) {
    const t = i / rate;
    const envelope = Math.exp(-t * 140);
    low += 0.35 * (random.next() * 2 - 1 - low);
    const wood = Math.sin(2 * Math.PI * 1150 * t) * Math.exp(-t * 220);
    out[start + i]! += gain * envelope * (0.7 * low + 0.5 * wood);
  }
}

// A sine (or a hollow square-ish wave) gliding from `from` to `to` Hz, with a soft attack
// and an exponential fade.
function tone(
  out: Float32Array,
  rate: number,
  at: number,
  seconds: number,
  from: number,
  to: number,
  gain: number,
  hollow = false,
): void {
  const start = Math.floor(at * rate);
  const length = Math.floor(seconds * rate);
  let phase = 0;
  for (let i = 0; i < length && start + i < out.length; i++) {
    const progress = i / length;
    const hz = from + (to - from) * progress;
    phase += (2 * Math.PI * hz) / rate;
    const attack = Math.min(1, i / (0.006 * rate));
    const envelope = attack * Math.exp(-progress * 4);
    const wave = hollow ? Math.sin(phase) + Math.sin(3 * phase) / 3 : Math.sin(phase);
    out[start + i]! += gain * envelope * wave;
  }
}

function normalize(samples: Float32Array<ArrayBuffer>, peak: number): Float32Array<ArrayBuffer> {
  let max = 0;
  for (const sample of samples) max = Math.max(max, Math.abs(sample));
  if (max === 0) return samples;
  const scale = peak / max;
  for (let i = 0; i < samples.length; i++) samples[i]! *= scale;
  return samples;
}
