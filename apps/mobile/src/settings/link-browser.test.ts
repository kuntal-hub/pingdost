import { beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import {
  deviceCertificateMessage,
  encodePairingQr,
  pairingApprovalMessage,
  toBase64Url,
  uuidv7,
} from '@pingdost/protocol';

import { approvalFor, inspectPairing, LinkError, readPairingCode } from './link-browser';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

function browserCode() {
  const browser = provider.createAccount();
  const keys = browser.identityKeys();
  const qr = {
    pairingId: uuidv7(),
    challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    curve25519: keys.curve25519,
    ed25519: keys.ed25519,
    origin: 'https://web.pingdost.com',
  };
  return { qr, text: encodePairingQr(qr) };
}

const details = (identityKeys: { curve25519: string; ed25519: string }) => ({
  name: 'Chrome on Windows',
  userAgent: null,
  identityKeys,
  createdAt: 1,
  expiresAt: 2,
});

describe('linking a browser (ADR 0019)', () => {
  it('reads PingDost browser codes only', () => {
    const { qr, text } = browserCode();
    expect(readPairingCode(text)).toEqual(qr);
    expect(() => readPairingCode('https://pingdost.com')).toThrow(LinkError);
    expect(() => readPairingCode('pingdost-safety:v1:abc')).toThrow(LinkError);
  });

  it('refuses when the server describes other keys than the code', async () => {
    const { qr } = browserCode();
    const same = await inspectPairing({ inspect: () => Promise.resolve(details(qr)) }, qr);
    expect(same.details.name).toBe('Chrome on Windows');
    const other = provider.createAccount().identityKeys();
    await expect(
      inspectPairing({ inspect: () => Promise.resolve(details(other)) }, qr),
    ).rejects.toBeInstanceOf(LinkError);
  });

  it("signs the pairing with the phone's device key and certifies the browser's keys", () => {
    const { qr } = browserCode();
    const phone = provider.createAccount();
    const identity = provider.createSigningKey();
    const deviceId = uuidv7();
    const approval = approvalFor(qr, deviceId, phone, identity);
    const webKeys = { curve25519: qr.curve25519, ed25519: qr.ed25519 };
    expect(approval).toMatchObject({ pairingId: qr.pairingId, deviceId, webKeys });
    expect(
      provider.verifyEd25519(
        phone.identityKeys().ed25519,
        pairingApprovalMessage(qr.pairingId, qr.challenge, deviceId, webKeys),
        approval.signature,
      ),
    ).toBe(true);
    expect(
      provider.verifyEd25519(
        identity.publicKey(),
        deviceCertificateMessage(deviceId, webKeys),
        approval.deviceCertificate,
      ),
    ).toBe(true);
  });
});
