/**
 * Phase 2 crypto gate: Olm / Megolm interop through the WASM CryptoProvider in Node.
 * Each `describe` is one scenario from docs/phases/phase-02-crypto-spike-core.md.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider } from '../src/index';
import type {
  CryptoProvider,
  MegolmInboundSession,
  OlmAccount,
  OlmCiphertext,
  OlmSession,
} from '../src/index';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

/** The key directory: a device publishes one-time keys; a peer claims one. */
function claimOneTimeKey(account: OlmAccount): string {
  account.generateOneTimeKeys(1);
  const [key] = account.oneTimeKeys();
  account.markKeysAsPublished();
  if (!key) throw new Error('no one-time key generated');
  return key.publicKey;
}

/** Opens a session from `sender` to `receiver` and delivers a first pre-key message. */
function connect(sender: OlmAccount, receiver: OlmAccount, oneTimeKey = claimOneTimeKey(receiver)) {
  const outbound = sender.createOutboundSession(receiver.identityKeys().curve25519, oneTimeKey);
  const first = outbound.encrypt(bytes('hello'));
  expect(first.type).toBe('prekey');
  const { session: inbound, plaintext } = receiver.createInboundSession(
    sender.identityKeys().curve25519,
    first,
  );
  expect(text(plaintext)).toBe('hello');
  return { outbound, inbound };
}

function flipLastByte(message: OlmCiphertext): OlmCiphertext {
  const body = message.body.slice();
  body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 0x01;
  return { ...message, body };
}

describe('1. pre-key flow via a claimed one-time key, then a normal ratchet exchange', () => {
  it('exchanges messages in both directions', () => {
    const alice = provider.createAccount();
    const bob = provider.createAccount();
    const { outbound: aliceToBob, inbound: bobFromAlice } = connect(alice, bob);

    // Before Bob replies, Alice keeps sending pre-key messages; Bob routes them by session ID.
    const again = aliceToBob.encrypt(bytes('still there?'));
    expect(again.type).toBe('prekey');
    expect(provider.prekeyMessageSessionId(again)).toBe(bobFromAlice.sessionId());
    expect(text(bobFromAlice.decrypt(again))).toBe('still there?');

    for (let round = 0; round < 3; round++) {
      const reply = bobFromAlice.encrypt(bytes(`bob ${round}`));
      expect(reply.type).toBe('normal');
      expect(text(aliceToBob.decrypt(reply))).toBe(`bob ${round}`);
      const next = aliceToBob.encrypt(bytes(`alice ${round}`));
      expect(next.type).toBe('normal');
      expect(text(bobFromAlice.decrypt(next))).toBe(`alice ${round}`);
    }
    expect(aliceToBob.hasReceivedMessage()).toBe(true);
    expect(aliceToBob.sessionId()).toBe(bobFromAlice.sessionId());
  });
});

describe('2. fallback key when one-time keys are exhausted', () => {
  it('lets several senders start sessions from the same fallback key', () => {
    const bob = provider.createAccount();
    bob.generateFallbackKey();
    const fallback = bob.fallbackKey();
    bob.markKeysAsPublished();
    expect(bob.oneTimeKeys()).toEqual([]);
    if (!fallback) throw new Error('no fallback key');

    const alice = connect(provider.createAccount(), bob, fallback.publicKey);
    const carol = connect(provider.createAccount(), bob, fallback.publicKey);
    expect(alice.inbound.sessionId()).not.toBe(carol.inbound.sessionId());
  });
});

describe('3. out-of-order delivery within a chain', () => {
  it('decrypts skipped messages when they arrive later', () => {
    const { outbound, inbound } = connect(provider.createAccount(), provider.createAccount());
    outbound.decrypt(inbound.encrypt(bytes('ack'))); // switch Alice to normal messages
    const messages = ['m1', 'm2', 'm3', 'm4'].map((m) => outbound.encrypt(bytes(m)));
    for (const index of [2, 0, 3, 1]) {
      expect(text(inbound.decrypt(messages[index] as OlmCiphertext))).toBe(`m${index + 1}`);
    }
  });
});

describe('4. replay', () => {
  it('rejects an Olm message that was already decrypted', () => {
    const { outbound, inbound } = connect(provider.createAccount(), provider.createAccount());
    outbound.decrypt(inbound.encrypt(bytes('ack')));
    const message = outbound.encrypt(bytes('once'));
    expect(text(inbound.decrypt(message))).toBe('once');
    expect(() => inbound.decrypt(message)).toThrow();
  });

  it('rejects a replayed pre-key message (the one-time key is used up)', () => {
    const alice = provider.createAccount();
    const bob = provider.createAccount();
    const outbound = alice.createOutboundSession(
      bob.identityKeys().curve25519,
      claimOneTimeKey(bob),
    );
    const first = outbound.encrypt(bytes('hello'));
    bob.createInboundSession(alice.identityKeys().curve25519, first);
    expect(() => bob.createInboundSession(alice.identityKeys().curve25519, first)).toThrow();
  });
});

describe('5. tampering', () => {
  it('fails authentication when one ciphertext byte is flipped (Olm)', () => {
    const { outbound, inbound } = connect(provider.createAccount(), provider.createAccount());
    outbound.decrypt(inbound.encrypt(bytes('ack')));
    const message = outbound.encrypt(bytes('secret plan'));
    let error: unknown;
    try {
      inbound.decrypt(flipLastByte(message));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret plan');
    // The session survives a forged message.
    expect(text(inbound.decrypt(message))).toBe('secret plan');
  });

  it('fails authentication when one ciphertext byte is flipped (Megolm)', () => {
    const outbound = provider.createOutboundGroupSession();
    const inbound = provider.createInboundGroupSession(outbound.sessionKey());
    const message = outbound.encrypt(bytes('group secret'));
    const forged = message.slice();
    forged[10] = (forged[10] ?? 0) ^ 0x01;
    expect(() => inbound.decrypt(forged)).toThrow();
    expect(text(inbound.decrypt(message).plaintext)).toBe('group secret');
  });
});

describe('6. Megolm membership change', () => {
  it('shares the room key over Olm and locks out a removed member after rotation', () => {
    const alice = provider.createAccount();
    const members = { bob: provider.createAccount(), carol: provider.createAccount() };
    const olm = {
      bob: connect(alice, members.bob),
      carol: connect(alice, members.carol),
    };

    /** Alice sends a group session key to one member over their Olm session. */
    const shareKey = (to: 'bob' | 'carol', sessionKey: string): MegolmInboundSession => {
      const received = olm[to].inbound.decrypt(olm[to].outbound.encrypt(bytes(sessionKey)));
      return provider.createInboundGroupSession(text(received));
    };

    const first = provider.createOutboundGroupSession();
    const bobInbound = shareKey('bob', first.sessionKey());
    const carolInbound = shareKey('carol', first.sessionKey());
    const hello = first.encrypt(bytes('hello group'));
    expect(text(bobInbound.decrypt(hello).plaintext)).toBe('hello group');
    expect(text(carolInbound.decrypt(hello).plaintext)).toBe('hello group');

    // Carol is removed: Alice rotates and shares the new key with Bob only.
    const rotated = provider.createOutboundGroupSession();
    expect(rotated.sessionId()).not.toBe(first.sessionId());
    const bobRotated = shareKey('bob', rotated.sessionKey());
    const afterRemoval = rotated.encrypt(bytes('without carol'));
    expect(text(bobRotated.decrypt(afterRemoval).plaintext)).toBe('without carol');
    expect(() => carolInbound.decrypt(afterRemoval)).toThrow();
  });

  it('returns the message index so the engine can reject Megolm replays', () => {
    const outbound = provider.createOutboundGroupSession();
    const inbound = provider.createInboundGroupSession(outbound.sessionKey());
    const message = outbound.encrypt(bytes('x'));
    // Megolm itself accepts a second decryption; the (sessionId, index) check is the
    // message engine's job (ADR 0003).
    expect(inbound.decrypt(message).messageIndex).toBe(0);
    expect(inbound.decrypt(message).messageIndex).toBe(0);
  });
});

describe('7. new member cannot read earlier messages', () => {
  it('gets the key at the current index (sessionKey or exportAt)', () => {
    const outbound = provider.createOutboundGroupSession();
    const bob = provider.createInboundGroupSession(outbound.sessionKey());
    const earlier = [outbound.encrypt(bytes('m0')), outbound.encrypt(bytes('m1'))];
    expect(outbound.messageIndex()).toBe(2);

    const viaSessionKey = provider.createInboundGroupSession(outbound.sessionKey());
    const exported = bob.exportAt(2);
    if (!exported) throw new Error('export failed');
    const viaExport = provider.importInboundGroupSession(exported);

    const later = outbound.encrypt(bytes('m2'));
    for (const dave of [viaSessionKey, viaExport]) {
      expect(dave.firstKnownIndex()).toBe(2);
      for (const message of earlier) expect(() => dave.decrypt(message)).toThrow();
      expect(text(dave.decrypt(later).plaintext)).toBe('m2');
    }
    expect(bob.exportAt(0)).toBeDefined();
  });
});

describe('8. pickles', () => {
  const key = new Uint8Array(32).fill(7);
  const wrongKey = new Uint8Array(32).fill(8);

  it('round-trips every object and keeps working afterwards', () => {
    const alice = provider.createAccount();
    const bob = provider.createAccount();
    const oneTimeKey = claimOneTimeKey(bob);
    const bobRestored = provider.restoreAccount(bob.pickle(key), key);
    expect(bobRestored.identityKeys()).toEqual(bob.identityKeys());

    // The restored account still holds the published one-time key.
    const { outbound, inbound } = connect(alice, bobRestored, oneTimeKey);
    const restoredInbound: OlmSession = provider.restoreSession(inbound.pickle(key), key);
    const restoredOutbound: OlmSession = provider.restoreSession(outbound.pickle(key), key);
    expect(text(restoredOutbound.decrypt(restoredInbound.encrypt(bytes('after restore'))))).toBe(
      'after restore',
    );

    const group = provider.createOutboundGroupSession();
    group.encrypt(bytes('advance'));
    const groupRestored = provider.restoreOutboundGroupSession(group.pickle(key), key);
    expect(groupRestored.messageIndex()).toBe(1);
    const member = provider.createInboundGroupSession(group.sessionKey());
    const memberRestored = provider.restoreInboundGroupSession(member.pickle(key), key);
    expect(text(memberRestored.decrypt(groupRestored.encrypt(bytes('g'))).plaintext)).toBe('g');
  });

  it('rejects a wrong or malformed pickle key', () => {
    const account = provider.createAccount();
    const { outbound } = connect(account, provider.createAccount());
    const group = provider.createOutboundGroupSession();
    const member = provider.createInboundGroupSession(group.sessionKey());

    expect(() => provider.restoreAccount(account.pickle(key), wrongKey)).toThrow();
    expect(() => provider.restoreSession(outbound.pickle(key), wrongKey)).toThrow();
    expect(() => provider.restoreOutboundGroupSession(group.pickle(key), wrongKey)).toThrow();
    expect(() => provider.restoreInboundGroupSession(member.pickle(key), wrongKey)).toThrow();
    expect(() => account.pickle(new Uint8Array(16))).toThrow();
  });
});

describe('9. multi-device fan-out', () => {
  it("encrypts one message to each of Alice's devices and Bob's own other device", () => {
    const alicePhone = provider.createAccount();
    const aliceWeb = provider.createAccount();
    const bobPhone = provider.createAccount();
    const bobWeb = provider.createAccount();

    const recipients = { alicePhone, aliceWeb, bobWeb };
    const delivered = Object.entries(recipients).map(([name, device]) => {
      const session = bobPhone.createOutboundSession(
        device.identityKeys().curve25519,
        claimOneTimeKey(device),
      );
      const message = session.encrypt(bytes('fan-out'));
      const { plaintext } = device.createInboundSession(
        bobPhone.identityKeys().curve25519,
        message,
      );
      return [name, text(plaintext)];
    });
    expect(Object.fromEntries(delivered)).toEqual({
      alicePhone: 'fan-out',
      aliceWeb: 'fan-out',
      bobWeb: 'fan-out',
    });
  });
});

describe('signatures', () => {
  it('verifies Ed25519 signatures strictly', () => {
    const account = provider.createAccount();
    const { ed25519 } = account.identityKeys();
    const signature = account.sign(bytes('device keys'));
    expect(provider.verifyEd25519(ed25519, bytes('device keys'), signature)).toBe(true);
    expect(provider.verifyEd25519(ed25519, bytes('device keyz'), signature)).toBe(false);
    expect(provider.verifyEd25519('not-a-key', bytes('device keys'), signature)).toBe(false);
  });
});
