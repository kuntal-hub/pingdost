/**
 * Padding policy (ADR 0006): an encoded Content is padded with zero bytes in its `padding`
 * field so its size is one of a few buckets. The ciphertext length then reveals only the
 * bucket, not the message length.
 */
import { toBinary } from '@bufbuild/protobuf';

import { ProtocolError } from './errors';
import { ContentSchema, type Content } from './gen/pingdost/v1/content_pb';

/** Sizes an encoded Content is padded up to; beyond the last, multiples of it. */
export const PADDING_BUCKETS: readonly number[] = [256, 1024, 4096, 16_384];

/** `padding` is field 15, so its tag is one byte. */
const PADDING_TAG_BYTES = 1;

function varintSize(value: number): number {
  let size = 1;
  for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) size++;
  return size;
}

/**
 * The padding length that grows an encoded Content by exactly `gap` bytes (tag + length
 * varint + the bytes), or undefined when no length does. An empty `padding` is not encoded
 * at all, so the length is at least 1.
 */
function paddingLengthFor(gap: number): number | undefined {
  for (let lengthBytes = 1; lengthBytes <= 5; lengthBytes++) {
    const length = gap - PADDING_TAG_BYTES - lengthBytes;
    if (length >= 1 && varintSize(length) === lengthBytes) return length;
  }
  return undefined;
}

/** Target sizes in order: the buckets that fit `size`, then multiples of the last, then `max`. */
function* targetSizes(size: number, max: number): Generator<number> {
  for (const bucket of PADDING_BUCKETS) if (bucket >= size && bucket < max) yield bucket;
  const step = PADDING_BUCKETS[PADDING_BUCKETS.length - 1] ?? 1;
  const first = Math.max(2 * step, Math.ceil(size / step) * step);
  for (let target = first; target < max; target += step) yield target;
}

/** The size `encodePaddedContent` produces for an unpadded Content of `size` bytes. */
export function paddedSize(size: number, max: number): number {
  for (const target of targetSizes(size, max)) {
    if (target === size || paddingLengthFor(target - size) !== undefined) return target;
  }
  // The cap: when no padding hits it exactly, land a byte or two below it.
  for (let target = max; target > size; target--) {
    if (paddingLengthFor(target - size) !== undefined) return target;
  }
  return size;
}

/** Encodes `content` (any existing padding replaced) padded to its bucket, at most `max` bytes. */
export function encodePaddedContent(content: Content, max: number): Uint8Array {
  const unpadded = toBinary(ContentSchema, { ...content, padding: new Uint8Array(0) });
  if (unpadded.length > max) {
    throw new ProtocolError('OVERSIZED', `Content exceeds ${max} bytes`);
  }
  const target = paddedSize(unpadded.length, max);
  if (target === unpadded.length) return unpadded;
  const length = paddingLengthFor(target - unpadded.length) ?? 0;
  return toBinary(ContentSchema, { ...content, padding: new Uint8Array(length) });
}
