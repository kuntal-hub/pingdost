import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import { decodeContent, encodeContent } from './codec';
import { ContentSchema, type Content } from './gen/pingdost/v1/content_pb';
import { uuidv7Bytes } from './ids';
import { limitsFor, PROTOCOL_VERSION } from './limits';
import { PADDING_BUCKETS, paddedSize } from './padding';

function text(length: number): Content {
  return create(ContentSchema, {
    header: {
      version: PROTOCOL_VERSION,
      messageId: uuidv7Bytes(),
      conversationId: uuidv7Bytes(),
      senderUserId: uuidv7Bytes(),
      sentAtMs: 1_760_000_000_000n,
    },
    body: { case: 'text', value: { body: 'a'.repeat(length) } },
  });
}

const cap = limitsFor().content;
const step = PADDING_BUCKETS[PADDING_BUCKETS.length - 1] ?? 0;
/** Every size a padded Content may have under the default limits. */
const allowed = new Set([...PADDING_BUCKETS, 2 * step, 3 * step, cap, cap - 1, cap - 2]);

describe('padding policy', () => {
  it('pads every Content size to a bucket and decodes back unchanged', () => {
    let longest = cap;
    while (toBinary(ContentSchema, text(longest)).length > cap) longest--;
    const lengths = [
      ...Array.from({ length: 1_200 }, (_, i) => i),
      ...Array.from({ length: 200 }, (_, i) => 3_900 + i),
      ...Array.from({ length: 200 }, (_, i) => 16_200 + i),
      40_000,
      ...Array.from({ length: 5 }, (_, i) => longest - i),
    ];
    for (const length of lengths) {
      const original = text(length);
      const unpadded = toBinary(ContentSchema, original).length;
      const encoded = encodeContent(original);
      expect(allowed.has(encoded.length), `text of ${length} → ${encoded.length} bytes`).toBe(true);
      expect(encoded.length).toBe(paddedSize(unpadded, cap));
      expect(encoded.length).toBeGreaterThanOrEqual(unpadded);
      expect(decodeContent(encoded).body).toEqual(original.body);
    }
  });

  it('chooses the smallest reachable bucket', () => {
    expect(paddedSize(10, cap)).toBe(256);
    expect(paddedSize(256, cap)).toBe(256);
    // 1 or 2 bytes short of a bucket cannot be filled (the padding field costs at least 3).
    expect(paddedSize(255, cap)).toBe(1024);
    expect(paddedSize(254, cap)).toBe(1024);
    expect(paddedSize(253, cap)).toBe(256);
    expect(paddedSize(5_000, cap)).toBe(16_384);
    expect(paddedSize(20_000, cap)).toBe(32_768);
  });

  it('pads to the cap, or just under it, above the last bucket that fits', () => {
    expect(paddedSize(50_000, cap)).toBe(cap);
    expect(paddedSize(cap - 1, cap)).toBe(cap - 1);
    expect(paddedSize(cap, cap)).toBe(cap);
    // A small ENVELOPE_MAX_BYTES caps the buckets too.
    const smallCap = limitsFor({ envelopeMaxBytes: 2_048 }).content;
    expect(paddedSize(300, smallCap)).toBe(smallCap);
  });

  it('replaces any existing padding', () => {
    const original = text(10);
    original.padding = new Uint8Array(500);
    expect(encodeContent(original).length).toBe(256);
  });
});
