import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeUtf8, encodeUtf8, fromBase64, fromHex, toBase64, toHex } from './bytes';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bytes', () => {
  it('round-trips hex', () => {
    const data = new Uint8Array([0, 1, 127, 128, 255]);
    expect(toHex(data)).toBe('00017f80ff');
    expect(fromHex('00017F80ff')).toEqual(data);
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });

  it('round-trips base64 like Node does', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 64, 257]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
      const text = Buffer.from(data).toString('base64');
      expect(toBase64(data)).toBe(text);
      expect(fromBase64(text)).toEqual(data);
    }
    expect(() => fromBase64('a$b')).toThrow();
  });

  it('decodes UTF-8 without TextDecoder (Hermes)', () => {
    const sample = 'pickle: ASCII, é, ↔, 🔐';
    vi.stubGlobal('TextDecoder', undefined);
    expect(decodeUtf8(encodeUtf8(sample))).toBe(sample);
  });
});
