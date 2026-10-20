import { describe, expect, it } from 'vitest';

import { ProtocolError } from './errors';
import { toBase64, toBase64Url, uuidv7 } from './ids';
import { encodePairingQr, PAIRING_QR_PREFIX, parsePairingQr, type PairingQr } from './pairing';
import { pairingApprovalMessage, SIGNING_CONTEXTS } from './signing';

const key = (fill: number) => toBase64(new Uint8Array(32).fill(fill)).replace(/=+$/, '');

function qr(overrides: Partial<PairingQr> = {}): PairingQr {
  return {
    pairingId: uuidv7(),
    challenge: toBase64Url(new Uint8Array(32).fill(7)),
    curve25519: key(1),
    ed25519: key(2),
    origin: 'https://app.pingdost.com',
    ...overrides,
  };
}

describe('pairing QR codes (ADR 0019)', () => {
  it('round-trips and carries no secret', () => {
    const code = qr();
    const text = encodePairingQr(code);
    expect(text.startsWith(PAIRING_QR_PREFIX)).toBe(true);
    expect(parsePairingQr(text)).toEqual(code);
    expect(parsePairingQr(encodePairingQr(qr({ origin: 'http://localhost:5173' }))).origin).toBe(
      'http://localhost:5173',
    );
  });

  it('refuses anything that is not exactly a pairing code', () => {
    const bad = [
      'https://example.com',
      `${PAIRING_QR_PREFIX}not-base64!`,
      `${PAIRING_QR_PREFIX}${toBase64Url(new TextEncoder().encode('[1,2]'))}`,
      encodePairingQr(qr({ challenge: toBase64Url(new Uint8Array(16)) })),
      encodePairingQr(qr({ ed25519: key(3).slice(0, 20) })),
      encodePairingQr(qr({ pairingId: 'not-a-uuid' })),
      encodePairingQr(qr({ origin: 'javascript:alert(1)' })),
      encodePairingQr(qr({ origin: 'https://app.pingdost.com/path' })),
    ];
    for (const text of bad) expect(() => parsePairingQr(text), text).toThrow(ProtocolError);
  });

  it('signs a context-prefixed, fixed-length approval statement', () => {
    const code = qr();
    const deviceId = uuidv7();
    const message = pairingApprovalMessage(code.pairingId, code.challenge, deviceId, {
      curve25519: code.curve25519,
      ed25519: code.ed25519,
    });
    const context = new TextEncoder().encode(SIGNING_CONTEXTS.pairingApproval);
    expect(message.subarray(0, context.length)).toEqual(context);
    expect(message[context.length]).toBe(0);
    expect(message.length).toBe(context.length + 1 + 16 + 32 + 16 + 32 + 32);
    expect(() =>
      pairingApprovalMessage(code.pairingId, toBase64Url(new Uint8Array(31)), deviceId, {
        curve25519: code.curve25519,
        ed25519: code.ed25519,
      }),
    ).toThrow(ProtocolError);
  });
});
