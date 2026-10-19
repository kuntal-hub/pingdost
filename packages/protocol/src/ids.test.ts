import { describe, expect, it } from 'vitest';

import { ProtocolError } from './errors';
import {
  bytesEqual,
  bytesToUuid,
  directConversationIdFor,
  envelopeIdFor,
  fromBase64,
  isUuid,
  toBase64,
  toBase64Url,
  uuidToBytes,
  uuidv7,
  uuidv7Bytes,
} from './ids';

const MESSAGE_ID = '0192f1a0-0000-7000-8000-000000000001';
const DEVICE_ID = '0192f1a0-0000-7000-8000-0000000000b2';

describe('directConversationIdFor', () => {
  it('gives both users the same stable UUID', () => {
    const id = directConversationIdFor(MESSAGE_ID, DEVICE_ID);
    expect(id).toBe(directConversationIdFor(DEVICE_ID, MESSAGE_ID));
    expect(id).toBe(directConversationIdFor(uuidToBytes(DEVICE_ID), MESSAGE_ID));
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('5');
    // Pinned: changing the namespace or byte order would split existing conversations.
    expect(id).toMatchInlineSnapshot(`"43b31080-4baf-5542-a727-240026f0142f"`);
    expect(directConversationIdFor(MESSAGE_ID, MESSAGE_ID)).not.toBe(id);
  });
});

describe('UUIDv7', () => {
  it('creates canonical, time-ordered v7 IDs', () => {
    const ids = Array.from({ length: 50 }, () => uuidv7());
    for (const id of ids) {
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('creates 16-byte IDs that format back to v7 strings', () => {
    const bytes = uuidv7Bytes();
    expect(bytes).toHaveLength(16);
    expect(bytesToUuid(bytes)[14]).toBe('7');
  });
});

describe('envelopeIdFor', () => {
  it('is UUIDv5 of (message ID, recipient device ID), deterministic and pinned', () => {
    const id = bytesToUuid(envelopeIdFor(MESSAGE_ID, DEVICE_ID));
    expect(id[14]).toBe('5');
    // Golden value: changing it breaks idempotent retransmits across versions.
    expect(id).toBe('bbb09c25-1864-50ca-a0be-eb189c0fd3ef');
    expect(envelopeIdFor(uuidToBytes(MESSAGE_ID), uuidToBytes(DEVICE_ID))).toEqual(
      envelopeIdFor(MESSAGE_ID, DEVICE_ID),
    );
  });

  it('differs per recipient device and per message', () => {
    const other = '0192f1a0-0000-7000-8000-0000000000b3';
    expect(envelopeIdFor(MESSAGE_ID, DEVICE_ID)).not.toEqual(envelopeIdFor(MESSAGE_ID, other));
    expect(envelopeIdFor(MESSAGE_ID, DEVICE_ID)).not.toEqual(envelopeIdFor(other, DEVICE_ID));
  });

  it('rejects IDs that are not 16 bytes or canonical UUIDs', () => {
    expect(() => envelopeIdFor(new Uint8Array(8), DEVICE_ID)).toThrow(ProtocolError);
    expect(() => envelopeIdFor('not-a-uuid', DEVICE_ID)).toThrow(ProtocolError);
  });
});

describe('byte ↔ string helpers', () => {
  it('converts UUIDs both ways and rejects non-canonical forms', () => {
    expect(bytesToUuid(uuidToBytes(MESSAGE_ID))).toBe(MESSAGE_ID);
    expect(isUuid(MESSAGE_ID.toUpperCase())).toBe(false);
    expect(() => uuidToBytes(MESSAGE_ID.toUpperCase())).toThrow(ProtocolError);
    expect(() => bytesToUuid(new Uint8Array(15))).toThrow(ProtocolError);
  });

  it('round-trips base64 and base64url', () => {
    const bytes = Uint8Array.from({ length: 33 }, (_, i) => i * 7);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromBase64(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
    expect(() => fromBase64('not base64!')).toThrow(ProtocolError);
  });

  it('compares bytes', () => {
    expect(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(bytesEqual(Uint8Array.from([1]), Uint8Array.from([1, 2]))).toBe(false);
  });
});
