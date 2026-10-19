/**
 * Safety numbers (ADR 0003, finalized in ADR 0012): a display encoding of both users'
 * **account identity keys**, so that linked browsers and replacement phones never change it.
 *
 * - Per user, Signal's numeric fingerprint: SHA-512 over `version (2 bytes, big-endian) ‖
 *   identity key (32 bytes) ‖ user ID (16 bytes)`, then 5,200 rounds of
 *   `hash = SHA-512(hash ‖ identity key)`; the first 30 bytes are the fingerprint.
 * - Shown as 30 digits per user: six 5-byte chunks, each a big-endian integer mod 100,000.
 *   The lower 30-digit string comes first, so both users see the same 60 digits (12 × 5).
 * - The QR code is `pingdost:sn:` + base64url(version ‖ shower's fingerprint ‖ the scanner's
 *   fingerprint). The scanner checks both halves against what it computed itself.
 * Only a standard hash is used; no new cryptography.
 */
import { sha512 } from '@noble/hashes/sha2.js';

import { ProtocolError } from './errors';
import { bytesEqual, fromBase64, toBase64Url, uuidToBytes } from './ids';

export const SAFETY_NUMBER_VERSION = 1;
const ITERATIONS = 5_200;
const FINGERPRINT_BYTES = 30;
const KEY_BYTES = 32;
const QR_PREFIX = 'pingdost:sn:';

export interface SafetyParty {
  userId: string;
  /** The account identity key (Ed25519, unpadded base64). */
  accountIdentityKey: string;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A SHA-512 implementation, e.g. a platform's native one (which may be asynchronous). */
export type Sha512Digest = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

function fingerprintInput(party: SafetyParty): { key: Uint8Array; first: Uint8Array } {
  const key = fromBase64(party.accountIdentityKey);
  if (key.length !== KEY_BYTES) {
    throw new ProtocolError('INVALID_FIELD', `an identity key is ${KEY_BYTES} bytes`);
  }
  const version = Uint8Array.of(SAFETY_NUMBER_VERSION >> 8, SAFETY_NUMBER_VERSION & 0xff);
  return { key, first: concat(version, key, uuidToBytes(party.userId)) };
}

/** One user's 30-byte fingerprint. Takes some milliseconds: compute once and cache. */
export function safetyFingerprint(party: SafetyParty): Uint8Array {
  const { key, first } = fingerprintInput(party);
  let hash = sha512(first);
  for (let i = 0; i < ITERATIONS; i++) hash = sha512(concat(hash, key));
  return hash.slice(0, FINGERPRINT_BYTES);
}

/** `safetyFingerprint` with another SHA-512, e.g. a native one that keeps the UI responsive. */
export async function safetyFingerprintAsync(
  party: SafetyParty,
  digest: Sha512Digest,
): Promise<Uint8Array> {
  const { key, first } = fingerprintInput(party);
  let hash = await digest(first);
  for (let i = 0; i < ITERATIONS; i++) hash = await digest(concat(hash, key));
  return hash.slice(0, FINGERPRINT_BYTES);
}

/** 30 digits from a fingerprint. */
export function fingerprintDigits(fingerprint: Uint8Array): string {
  if (fingerprint.length !== FINGERPRINT_BYTES) {
    throw new ProtocolError('INVALID_FIELD', `a fingerprint is ${FINGERPRINT_BYTES} bytes`);
  }
  let digits = '';
  for (let offset = 0; offset < FINGERPRINT_BYTES; offset += 5) {
    let chunk = 0;
    // 40 bits stay exact in a double.
    for (let i = 0; i < 5; i++) chunk = chunk * 256 + (fingerprint[offset + i] ?? 0);
    digits += String(chunk % 100_000).padStart(5, '0');
  }
  return digits;
}

export interface SafetyNumber {
  /** 60 digits, the same on both phones. */
  digits: string;
  /** The digits in 12 groups of 5, for display. */
  groups: string[];
  local: Uint8Array;
  remote: Uint8Array;
}

/** The safety number between this user (`local`) and a contact (`remote`). */
export function safetyNumber(
  local: SafetyParty | Uint8Array,
  remote: SafetyParty | Uint8Array,
): SafetyNumber {
  const localPrint = local instanceof Uint8Array ? local : safetyFingerprint(local);
  const remotePrint = remote instanceof Uint8Array ? remote : safetyFingerprint(remote);
  const a = fingerprintDigits(localPrint);
  const b = fingerprintDigits(remotePrint);
  const digits = a <= b ? a + b : b + a;
  return {
    digits,
    groups: digits.match(/\d{5}/g) ?? [],
    local: localPrint,
    remote: remotePrint,
  };
}

/** The QR text this user shows: their own fingerprint, then the contact's. */
export function encodeSafetyQr(number: SafetyNumber): string {
  return (
    QR_PREFIX +
    toBase64Url(concat(Uint8Array.of(SAFETY_NUMBER_VERSION), number.local, number.remote))
  );
}

export type SafetyQrResult =
  /** Both fingerprints agree: the contact can be marked verified. */
  | 'match'
  /** A PingDost safety code, but for other keys (or other people). */
  | 'mismatch'
  /** Made by a newer app version. */
  | 'unsupported_version'
  /** Not a PingDost safety code. */
  | 'invalid';

/** Checks a QR code scanned from the contact's screen against this user's own view. */
export function verifySafetyQr(text: string, number: SafetyNumber): SafetyQrResult {
  if (!text.startsWith(QR_PREFIX)) return 'invalid';
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(text.slice(QR_PREFIX.length));
  } catch {
    return 'invalid';
  }
  if (bytes.length !== 1 + 2 * FINGERPRINT_BYTES) return 'invalid';
  if (bytes[0] !== SAFETY_NUMBER_VERSION) return 'unsupported_version';
  // Shown by the contact: their fingerprint first, then ours.
  const theirs = bytes.slice(1, 1 + FINGERPRINT_BYTES);
  const ours = bytes.slice(1 + FINGERPRINT_BYTES);
  return bytesEqual(theirs, number.remote) && bytesEqual(ours, number.local) ? 'match' : 'mismatch';
}
