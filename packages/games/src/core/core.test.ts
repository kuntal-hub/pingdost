import { describe, expect, it } from 'vitest';

import { GAME_CATALOG } from './catalog';
import { cryptoRandom, seededRandom } from './random';
import { encodeWav, GAME_SOUND_RATE, GAME_SOUNDS, synthesizeGameSound } from './sounds';
import { normalizeStats, recordResult, totals } from './stats';

describe('random', () => {
  it('repeats a seeded sequence and differs between seeds', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const c = seededRandom(8);
    const first = Array.from({ length: 20 }, () => a.die());
    expect(Array.from({ length: 20 }, () => b.die())).toEqual(first);
    expect(Array.from({ length: 20 }, () => c.die())).not.toEqual(first);
  });

  it('rolls fair dice from the CSPRNG', () => {
    const random = cryptoRandom();
    const counts = [0, 0, 0, 0, 0, 0];
    const rolls = 60_000;
    for (let i = 0; i < rolls; i++) counts[random.die() - 1]!++;
    // Each face within 5% of 10,000 (about 5 standard deviations).
    for (const count of counts) expect(Math.abs(count - rolls / 6)).toBeLessThan(500);
    expect(random.int(1)).toBe(0);
    expect(() => random.int(0)).toThrow(RangeError);
    const x = random.next();
    expect(x >= 0 && x < 1).toBe(true);
  });
});

describe('stats', () => {
  it('counts games per mode and adds them up', () => {
    let book = recordResult({}, 'ludo', { solo: 'hard' }, true);
    book = recordResult(book, 'ludo', { solo: 'easy' }, false);
    book = recordResult(book, 'ludo', 'friends', true);
    expect(book.ludo!.solo.hard).toEqual({ played: 1, won: 1 });
    expect(totals(book.ludo)).toEqual({ played: 3, won: 2 });
    expect(totals(undefined)).toEqual({ played: 0, won: 0 });
  });

  it('reads stored stats defensively', () => {
    expect(normalizeStats('x')).toEqual({});
    const book = normalizeStats({
      ludo: { solo: { hard: { played: 2, won: 5 } }, friends: { played: -1 } },
    });
    expect(book.ludo!.solo.hard).toEqual({ played: 2, won: 2 });
    expect(book.ludo!.friends).toEqual({ played: 0, won: 0 });
  });
});

describe('sounds', () => {
  it('makes every sound in range, with a peak, the same each time', () => {
    for (const kind of GAME_SOUNDS) {
      const samples = synthesizeGameSound(kind);
      expect(samples.length, kind).toBeGreaterThan(GAME_SOUND_RATE * 0.05);
      const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
      expect(peak, kind).toBeCloseTo(0.8, 5);
      expect(synthesizeGameSound(kind), kind).toEqual(samples);
    }
  });

  it('wraps samples as a 16-bit mono WAV', () => {
    const samples = new Float32Array([0, 1, -1, 0.5]);
    const wav = encodeWav(samples, 8000);
    const text = (from: number, to: number) => String.fromCharCode(...wav.slice(from, to));
    const view = new DataView(wav.buffer);
    expect([text(0, 4), text(8, 12), text(36, 40)]).toEqual(['RIFF', 'WAVE', 'data']);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(46, true), view.getInt16(48, true)]).toEqual([32767, -32767]);
  });
});

describe('catalog', () => {
  it('lists Ludo as playable and every game once', () => {
    expect(GAME_CATALOG.filter((g) => g.available).map((g) => g.id)).toEqual(['ludo']);
    expect(new Set(GAME_CATALOG.map((g) => g.id)).size).toBe(GAME_CATALOG.length);
  });
});
