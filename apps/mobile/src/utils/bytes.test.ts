import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeUtf8, encodeUtf8, fromHex, toHex } from './bytes';

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

  it('decodes UTF-8 without TextDecoder (Hermes)', () => {
    const sample = 'pickle: ASCII, é, ↔, 🔐';
    vi.stubGlobal('TextDecoder', undefined);
    expect(decodeUtf8(encodeUtf8(sample))).toBe(sample);
  });
});
