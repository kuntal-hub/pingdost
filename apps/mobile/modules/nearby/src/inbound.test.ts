import { describe, expect, it } from 'vitest';

import { encodeInbound, parseInbound } from './inbound';

describe('nearby inbound batches', () => {
  it('round-trips packets, including empty ones', () => {
    const packets = [
      { linkId: 1, data: new Uint8Array([1, 2, 3]) },
      { linkId: 7, data: new Uint8Array(0) },
      { linkId: 0xffffffff, data: new Uint8Array(300).fill(9) },
    ];
    const parsed = parseInbound(encodeInbound(packets));
    expect(parsed.map((p) => p.linkId)).toEqual([1, 7, 0xffffffff]);
    expect(parsed.map((p) => Array.from(p.data))).toEqual(packets.map((p) => Array.from(p.data)));
  });

  it('matches the native layout (big-endian id and length)', () => {
    const batch = encodeInbound([{ linkId: 0x01020304, data: new Uint8Array([0xaa]) }]);
    expect(Array.from(batch)).toEqual([1, 2, 3, 4, 0, 0, 0, 1, 0xaa]);
  });

  it('reads a batch that is a view into a larger buffer', () => {
    const inner = encodeInbound([{ linkId: 2, data: new Uint8Array([5, 6]) }]);
    const outer = new Uint8Array(inner.length + 4);
    outer.set(inner, 4);
    expect(Array.from(parseInbound(outer.subarray(4))[0]!.data)).toEqual([5, 6]);
  });

  it('treats an empty batch as no packets and rejects truncated ones', () => {
    expect(parseInbound(new Uint8Array(0))).toEqual([]);
    const batch = encodeInbound([{ linkId: 1, data: new Uint8Array(4) }]);
    expect(() => parseInbound(batch.subarray(0, 6))).toThrow('truncated');
    expect(() => parseInbound(batch.subarray(0, batch.length - 1))).toThrow('truncated');
  });
});
