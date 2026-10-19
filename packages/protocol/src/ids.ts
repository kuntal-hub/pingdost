/**
 * IDs (ARCHITECTURE A8). Users, devices, messages, packets, groups, attachments and pairing
 * requests use UUIDv7: 16 bytes in protobuf, the canonical lowercase string in REST and
 * storage. React Native needs `crypto.getRandomValues` installed on `globalThis` (e.g. from
 * expo-crypto) before `uuidv7()` is called.
 */
import { base64Decode, base64Encode } from '@bufbuild/protobuf/wire';
import { parse, stringify, v5, v7, validate } from 'uuid';

import { ProtocolError } from './errors';

export const UUID_BYTES = 16;

/**
 * The fixed UUIDv5 namespace for envelope IDs. Never change it: retransmits of a message
 * must reuse its envelope IDs (ARCHITECTURE A3).
 */
export const ENVELOPE_ID_NAMESPACE = '7a9f4a0a-78e5-4e69-99d3-4cd3fac446d6';

/**
 * The fixed UUIDv5 namespace for direct (1:1) conversation IDs. Never change it: both users
 * derive the same ID independently (ADR 0011).
 */
export const DIRECT_CONVERSATION_NAMESPACE = 'c3a1d5e2-4b7f-4f0e-9a26-5d8e1f3b7c90';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A new UUIDv7 as a canonical string. */
export function uuidv7(): string {
  return v7();
}

/** A new UUIDv7 as 16 bytes. */
export function uuidv7Bytes(): Uint8Array {
  return v7(undefined, new Uint8Array(UUID_BYTES));
}

/** Whether `value` is a UUID in canonical lowercase form. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value) && validate(value);
}

/** Parses a canonical UUID string to 16 bytes. */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!isUuid(uuid)) throw new ProtocolError('INVALID_FIELD', 'not a canonical UUID');
  return parse(uuid);
}

/** Formats 16 bytes as a canonical UUID string. */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== UUID_BYTES) {
    throw new ProtocolError('INVALID_FIELD', `a UUID is ${UUID_BYTES} bytes`);
  }
  try {
    return stringify(bytes);
  } catch {
    throw new ProtocolError('INVALID_FIELD', 'not a valid UUID');
  }
}

function idBytes(id: Uint8Array | string): Uint8Array {
  if (typeof id === 'string') return uuidToBytes(id);
  if (id.length !== UUID_BYTES) {
    throw new ProtocolError('INVALID_FIELD', `an ID is ${UUID_BYTES} bytes`);
  }
  return id;
}

/**
 * The envelope ID for one message to one recipient device:
 * UUIDv5(ENVELOPE_ID_NAMESPACE, messageId bytes ‖ recipientDeviceId bytes), 16 bytes.
 */
export function envelopeIdFor(
  messageId: Uint8Array | string,
  recipientDeviceId: Uint8Array | string,
): Uint8Array {
  const name = new Uint8Array(2 * UUID_BYTES);
  name.set(idBytes(messageId), 0);
  name.set(idBytes(recipientDeviceId), UUID_BYTES);
  return v5(name, ENVELOPE_ID_NAMESPACE, new Uint8Array(UUID_BYTES));
}

/**
 * The conversation ID two users share for their direct chat, as a canonical UUID string:
 * UUIDv5(DIRECT_CONVERSATION_NAMESPACE, lower user ID bytes ‖ higher user ID bytes). The
 * order does not matter: `directConversationIdFor(a, b) === directConversationIdFor(b, a)`.
 */
export function directConversationIdFor(
  userA: Uint8Array | string,
  userB: Uint8Array | string,
): string {
  const a = idBytes(userA);
  const b = idBytes(userB);
  const [low, high] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const name = new Uint8Array(2 * UUID_BYTES);
  name.set(low, 0);
  name.set(high, UUID_BYTES);
  return v5(name, DIRECT_CONVERSATION_NAMESPACE);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Standard base64 with padding (keys and signatures in REST DTOs). */
export function toBase64(bytes: Uint8Array): string {
  return base64Encode(bytes, 'std');
}

/** URL-safe base64 without padding (tokens in URLs and QR codes). */
export function toBase64Url(bytes: Uint8Array): string {
  return base64Encode(bytes, 'url');
}

/** Decodes standard or URL-safe base64, with or without padding. */
export function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) {
    throw new ProtocolError('INVALID_FIELD', 'not base64');
  }
  return base64Decode(value);
}

/** Constant-time comparison of two byte arrays of equal length. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
