import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { fromBase64, toBase64, uuidToBytes } from './ids';
import {
  encodeSafetyQr,
  fingerprintDigits,
  safetyFingerprint,
  safetyFingerprintAsync,
  safetyNumber,
  verifySafetyQr,
} from './safety-number';

const key = (fill: number) => toBase64(new Uint8Array(32).fill(fill)).replace(/=+$/, '');
const alice = { userId: '0192f1a0-0000-7000-8000-00000000000a', accountIdentityKey: key(1) };
const bob = { userId: '0192f1a0-0000-7000-8000-00000000000b', accountIdentityKey: key(2) };

describe('safety numbers', () => {
  it('shows both users the same 60 digits in 12 groups', () => {
    const forAlice = safetyNumber(alice, bob);
    const forBob = safetyNumber(bob, alice);
    expect(forAlice.digits).toBe(forBob.digits);
    expect(forAlice.digits).toMatch(/^\d{60}$/);
    expect(forAlice.groups).toHaveLength(12);
    // Pinned: a change here would show every existing contact a new safety number.
    expect(forAlice.digits).toMatchInlineSnapshot(
      `"459903227701264242505190942871609904278208958483373715422320"`,
    );
  });

  it('changes with the identity key or the user ID', () => {
    const base = safetyNumber(alice, bob).digits;
    expect(safetyNumber(alice, { ...bob, accountIdentityKey: key(3) }).digits).not.toBe(base);
    expect(
      safetyNumber(alice, { ...bob, userId: '0192f1a0-0000-7000-8000-00000000000c' }).digits,
    ).not.toBe(base);
  });

  it('encodes 5-byte chunks as big-endian numbers mod 100000', () => {
    const bytes = new Uint8Array(30);
    bytes.set([0, 0, 0, 0x01, 0x00], 0); // 256
    bytes.set([0xff, 0xff, 0xff, 0xff, 0xff], 5); // 2^40 − 1 = 1099511627775
    expect(fingerprintDigits(bytes)).toBe('00256' + '27775' + '00000'.repeat(4));
  });

  it('verifies the QR code shown on the contact’s phone', () => {
    const forAlice = safetyNumber(alice, bob);
    const shownByBob = encodeSafetyQr(safetyNumber(bob, alice));
    expect(verifySafetyQr(shownByBob, forAlice)).toBe('match');
    // Alice's own code, or one for other keys, does not verify bob.
    expect(verifySafetyQr(encodeSafetyQr(forAlice), forAlice)).toBe('mismatch');
    const mallory = { ...bob, accountIdentityKey: key(9) };
    expect(verifySafetyQr(encodeSafetyQr(safetyNumber(mallory, alice)), forAlice)).toBe('mismatch');
    expect(verifySafetyQr('https://example.com', forAlice)).toBe('invalid');
    expect(verifySafetyQr('pingdost:sn:AAAA', forAlice)).toBe('invalid');
    const future = 'pingdost:sn:' + shownByBob.slice('pingdost:sn:'.length).replace(/^A/, 'C');
    expect(verifySafetyQr(future, forAlice)).toBe('unsupported_version');
  });

  it('rejects malformed keys', () => {
    expect(() => safetyFingerprint({ ...alice, accountIdentityKey: 'AAAA' })).toThrow();
  });

  it('matches an independent SHA-512 implementation (node:crypto)', () => {
    const keyBytes = fromBase64(alice.accountIdentityKey);
    let hash: Uint8Array = createHash('sha512')
      .update(Uint8Array.of(0, 1))
      .update(keyBytes)
      .update(uuidToBytes(alice.userId))
      .digest();
    for (let i = 0; i < 5_200; i++)
      hash = createHash('sha512').update(hash).update(keyBytes).digest();
    expect(safetyFingerprint(alice)).toEqual(new Uint8Array(hash.subarray(0, 30)));
  });

  it('gives the same fingerprint with an asynchronous digest', async () => {
    const digest = (data: Uint8Array) =>
      Promise.resolve(new Uint8Array(createHash('sha512').update(data).digest()));
    expect(await safetyFingerprintAsync(bob, digest)).toEqual(safetyFingerprint(bob));
  });
});
