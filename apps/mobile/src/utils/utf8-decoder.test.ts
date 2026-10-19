import { describe, expect, it } from 'vitest';

import { hasStrictTextDecoder, Utf8TextDecoder } from './utf8-decoder';

const reference = (fatal: boolean) => new TextDecoder('utf-8', { fatal });

/** A deterministic byte generator, so failures reproduce. */
function bytes(seed: number, length: number): Uint8Array {
  let state = seed;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    // Bias towards the interesting lead and continuation bytes.
    const r = state >>> 24;
    out[i] =
      r < 64
        ? r
        : r < 128
          ? 0x80 | (r & 0x3f)
          : r < 160
            ? 0xc0 | (r & 0x1f)
            : r < 200
              ? 0xe0 | (r & 0x0f)
              : r < 240
                ? 0xf0 | (r & 0x07)
                : r;
  }
  return out;
}

describe('Utf8TextDecoder', () => {
  it('decodes text like the platform decoder, BOM included', () => {
    const encoder = new TextEncoder();
    for (const text of ['', 'hello', 'नमस्ते', '€ 😀 𝄞', '\uFEFFbom', 'a\u0000b']) {
      const encoded = encoder.encode(text);
      expect(new Utf8TextDecoder().decode(encoded)).toBe(reference(false).decode(encoded));
    }
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);
    expect(new Utf8TextDecoder('utf-8', { ignoreBOM: true }).decode(bom)).toBe('\uFEFFa');
  });

  it('matches the platform decoder on arbitrary bytes, replacing or throwing alike', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const input = bytes(seed, 1 + (seed % 40));
      expect(new Utf8TextDecoder().decode(input), `seed ${seed}`).toBe(
        reference(false).decode(input),
      );
      let expected: string | undefined;
      try {
        expected = reference(true).decode(input);
      } catch {
        expected = undefined;
      }
      if (expected === undefined) {
        expect(() => new Utf8TextDecoder('utf-8', { fatal: true }).decode(input)).toThrow(
          TypeError,
        );
      } else {
        expect(new Utf8TextDecoder('utf-8', { fatal: true }).decode(input)).toBe(expected);
      }
    }
  });

  it('rejects overlong forms, surrogates and truncated sequences in fatal mode', () => {
    const strict = new Utf8TextDecoder('utf-8', { fatal: true });
    for (const invalid of [
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
      [0x80],
    ]) {
      expect(() => strict.decode(Uint8Array.from(invalid))).toThrow(TypeError);
    }
  });

  it('decodes long input and views into larger buffers', () => {
    const text = 'x€'.repeat(20_000);
    const encoded = new TextEncoder().encode(text);
    const padded = new Uint8Array(encoded.length + 4);
    padded.set(encoded, 2);
    expect(new Utf8TextDecoder().decode(padded.subarray(2, 2 + encoded.length))).toBe(text);
  });

  it('accepts only UTF-8 labels', () => {
    expect(() => new Utf8TextDecoder('latin1')).toThrow(RangeError);
    expect(new Utf8TextDecoder(' UTF8 ').encoding).toBe('utf-8');
  });
});

describe('hasStrictTextDecoder', () => {
  it('accepts a decoder that throws in fatal mode, and nothing else', () => {
    expect(hasStrictTextDecoder({ TextDecoder })).toBe(true);
    expect(hasStrictTextDecoder({ TextDecoder: Utf8TextDecoder })).toBe(true);
    expect(hasStrictTextDecoder({})).toBe(false);
    class Lenient {
      decode(input: Uint8Array) {
        return new TextDecoder().decode(input);
      }
    }
    expect(hasStrictTextDecoder({ TextDecoder: Lenient })).toBe(false);
  });
});
