// Game sounds in the browser (ADR 0050): the same sounds `@pingdost/games` generates for the
// phone, as Web Audio buffers made on first use (browsers allow audio after a click). Nothing is
// downloaded; the CSP is unaffected.
import { GAME_SOUND_RATE, synthesizeGameSound, type GameSound } from '@pingdost/games';

import { useGames } from './store';

let context: AudioContext | null = null;
const buffers = new Map<GameSound, AudioBuffer>();

function bufferFor(audio: AudioContext, kind: GameSound): AudioBuffer {
  const ready = buffers.get(kind);
  if (ready) return ready;
  const samples = synthesizeGameSound(kind, GAME_SOUND_RATE);
  const buffer = audio.createBuffer(1, samples.length, GAME_SOUND_RATE);
  buffer.copyToChannel(samples, 0);
  buffers.set(kind, buffer);
  return buffer;
}

/** Plays a game sound if Game sounds is on (and the browser allows audio). */
export function playGameSound(kind: GameSound): void {
  if (!useGames.getState().sounds) return;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = 0.6;
    source.buffer = bufferFor(context, kind);
    source.connect(gain).connect(context.destination);
    source.start();
  } catch {
    // No audio (blocked or unsupported): the game goes on silently.
  }
}
