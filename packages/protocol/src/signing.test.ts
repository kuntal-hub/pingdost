import { describe, expect, it } from 'vitest';

import { ProtocolError } from './errors';
import { toBase64 } from './ids';
import {
  deviceCertificateMessage,
  deviceRegistrationMessage,
  signedKeyMessage,
  SIGNING_CONTEXTS,
} from './signing';

const DEVICE = '0192f1a0-0000-7000-8000-0000000000b2';
// vodozemac-style unpadded base64 of 32 bytes.
const key = (fill: number) => toBase64(new Uint8Array(32).fill(fill)).replace(/=+$/, '');
const KEYS = { curve25519: key(1), ed25519: key(2) };
const NONCE = new Uint8Array(32).fill(9);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('signed statements', () => {
  it('encodes a device certificate exactly (golden)', () => {
    const message = deviceCertificateMessage(DEVICE, KEYS);
    const prefix = `${hex(new TextEncoder().encode(SIGNING_CONTEXTS.deviceCertificate))}00`;
    expect(hex(message)).toBe(
      `${prefix}0192f1a0000070008000${'0'.repeat(10)}b2${'01'.repeat(32)}${'02'.repeat(32)}`,
    );
  });

  it('separates every purpose, so signatures cannot be reused across them', () => {
    const messages = [
      deviceCertificateMessage(DEVICE, KEYS),
      deviceRegistrationMessage(NONCE, DEVICE, KEYS),
      signedKeyMessage('one_time', DEVICE, 'AAAAAQ', KEYS.curve25519),
      signedKeyMessage('fallback', DEVICE, 'AAAAAQ', KEYS.curve25519),
    ].map(hex);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('accepts string or byte inputs alike', () => {
    expect(deviceRegistrationMessage(toBase64(NONCE), DEVICE, KEYS)).toEqual(
      deviceRegistrationMessage(NONCE, DEVICE, KEYS),
    );
  });

  it('rejects keys, nonces and key IDs of the wrong size', () => {
    expect(() => deviceCertificateMessage(DEVICE, { ...KEYS, ed25519: 'AAAA' })).toThrow(
      ProtocolError,
    );
    expect(() => deviceRegistrationMessage(new Uint8Array(8), DEVICE, KEYS)).toThrow(ProtocolError);
    expect(() => signedKeyMessage('one_time', DEVICE, '', KEYS.curve25519)).toThrow(ProtocolError);
    expect(() => signedKeyMessage('one_time', DEVICE, 'x'.repeat(65), KEYS.curve25519)).toThrow(
      ProtocolError,
    );
    expect(() => deviceCertificateMessage('not-a-uuid', KEYS)).toThrow(ProtocolError);
  });
});
