/**
 * The Phase 2 conformance scenarios, independent of the test runner so they run in Vitest
 * (WASM) and on a phone (native) through the same `CryptoProvider` (ADR 0003, ADR 0005).
 */
import type {
  CryptoProvider,
  MegolmInboundSession,
  OlmAccount,
  OlmCiphertext,
  OlmSession,
} from '../types';
import { check, checkEqual, checkThrows } from './check';

export interface Scenario {
  id: string;
  title: string;
  run: (provider: CryptoProvider) => void;
}

export const bytes = (value: string) => new TextEncoder().encode(value);

/** UTF-8 decode. Hermes ships TextEncoder but not always TextDecoder, hence the fallback. */
export function text(data: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(data);
  let out = '';
  for (let i = 0; i < data.length;) {
    const first = data[i++] ?? 0;
    const extra = first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : first >= 0xc0 ? 1 : 0;
    let code = extra === 0 ? first : first & (0x3f >> extra);
    for (let n = 0; n < extra; n++) code = (code << 6) | ((data[i++] ?? 0) & 0x3f);
    out += String.fromCodePoint(code);
  }
  return out;
}

/** The key directory: a device publishes one-time keys; a peer claims one. */
export function claimOneTimeKey(account: OlmAccount): string {
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
  checkEqual(first.type, 'prekey', 'first message is a pre-key message');
  const { session: inbound, plaintext } = receiver.createInboundSession(
    sender.identityKeys().curve25519,
    first,
  );
  checkEqual(text(plaintext), 'hello', 'pre-key message decrypts');
  return { outbound, inbound };
}

function flipLastByte(message: OlmCiphertext): OlmCiphertext {
  const body = message.body.slice();
  body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 0x01;
  return { ...message, body };
}

const pickleKey = new Uint8Array(32).fill(7);
const wrongPickleKey = new Uint8Array(32).fill(8);

export const scenarios: Scenario[] = [
  {
    id: '1',
    title: 'Pre-key flow via a claimed one-time key, then a normal ratchet exchange',
    run(provider) {
      const alice = provider.createAccount();
      const bob = provider.createAccount();
      const { outbound: aliceToBob, inbound: bobFromAlice } = connect(alice, bob);

      // Before Bob replies, Alice keeps sending pre-key messages; Bob routes them by session ID.
      const again = aliceToBob.encrypt(bytes('still there?'));
      checkEqual(again.type, 'prekey', 'unanswered session keeps sending pre-key messages');
      checkEqual(
        provider.prekeyMessageSessionId(again),
        bobFromAlice.sessionId(),
        'pre-key message routes to the existing session',
      );
      checkEqual(text(bobFromAlice.decrypt(again)), 'still there?', 'repeat pre-key decrypts');

      for (let round = 0; round < 3; round++) {
        const reply = bobFromAlice.encrypt(bytes(`bob ${round}`));
        checkEqual(reply.type, 'normal', 'reply is a normal message');
        checkEqual(text(aliceToBob.decrypt(reply)), `bob ${round}`, 'reply decrypts');
        const next = aliceToBob.encrypt(bytes(`alice ${round}`));
        checkEqual(next.type, 'normal', 'answered session sends normal messages');
        checkEqual(text(bobFromAlice.decrypt(next)), `alice ${round}`, 'normal message decrypts');
      }
      check(aliceToBob.hasReceivedMessage(), 'outbound session has received a message');
      checkEqual(aliceToBob.sessionId(), bobFromAlice.sessionId(), 'both sides share a session ID');
    },
  },
  {
    id: '2',
    title: 'Fallback key lets several senders start sessions when one-time keys run out',
    run(provider) {
      const bob = provider.createAccount();
      bob.generateFallbackKey();
      const fallback = bob.fallbackKey();
      bob.markKeysAsPublished();
      checkEqual(bob.oneTimeKeys(), [], 'no unpublished one-time keys');
      if (!fallback) throw new Error('no fallback key');

      const alice = connect(provider.createAccount(), bob, fallback.publicKey);
      const carol = connect(provider.createAccount(), bob, fallback.publicKey);
      check(
        alice.inbound.sessionId() !== carol.inbound.sessionId(),
        'each sender gets its own session',
      );
    },
  },
  {
    id: '3',
    title: 'Out-of-order delivery within a chain',
    run(provider) {
      const { outbound, inbound } = connect(provider.createAccount(), provider.createAccount());
      outbound.decrypt(inbound.encrypt(bytes('ack'))); // switch Alice to normal messages
      const messages = ['m1', 'm2', 'm3', 'm4'].map((m) => outbound.encrypt(bytes(m)));
      for (const index of [2, 0, 3, 1]) {
        checkEqual(
          text(inbound.decrypt(messages[index] as OlmCiphertext)),
          `m${index + 1}`,
          'skipped message decrypts later',
        );
      }
    },
  },
  {
    id: '4a',
    title: 'Replay: an Olm message that was already decrypted is rejected',
    run(provider) {
      const { outbound, inbound } = connect(provider.createAccount(), provider.createAccount());
      outbound.decrypt(inbound.encrypt(bytes('ack')));
      const message = outbound.encrypt(bytes('once'));
      checkEqual(text(inbound.decrypt(message)), 'once', 'first delivery decrypts');
      checkThrows(() => inbound.decrypt(message), 'replayed Olm message');
    },
  },
  {
    id: '4b',
    title: 'Replay: a replayed pre-key message is rejected (the one-time key is used up)',
    run(provider) {
      const alice = provider.createAccount();
      const bob = provider.createAccount();
      const outbound = alice.createOutboundSession(
        bob.identityKeys().curve25519,
        claimOneTimeKey(bob),
      );
      const first = outbound.encrypt(bytes('hello'));
      bob.createInboundSession(alice.identityKeys().curve25519, first);
      checkThrows(
        () => bob.createInboundSession(alice.identityKeys().curve25519, first),
        'second inbound session from the same pre-key message',
      );
    },
  },
  {
    id: '5a',
    title: 'Tampering: a flipped ciphertext byte fails authentication (Olm)',
    run(provider) {
      const { outbound, inbound } = connect(provider.createAccount(), provider.createAccount());
      outbound.decrypt(inbound.encrypt(bytes('ack')));
      const message = outbound.encrypt(bytes('secret plan'));
      const error = checkThrows(() => inbound.decrypt(flipLastByte(message)), 'forged Olm message');
      check(error instanceof Error, 'forgery raises an Error');
      check(!String(error).includes('secret plan'), 'error does not leak plaintext');
      // The session survives a forged message.
      checkEqual(text(inbound.decrypt(message)), 'secret plan', 'genuine message still decrypts');
    },
  },
  {
    id: '5b',
    title: 'Tampering: a flipped ciphertext byte fails authentication (Megolm)',
    run(provider) {
      const outbound = provider.createOutboundGroupSession();
      const inbound = provider.createInboundGroupSession(outbound.sessionKey());
      const message = outbound.encrypt(bytes('group secret'));
      const forged = message.slice();
      forged[10] = (forged[10] ?? 0) ^ 0x01;
      checkThrows(() => inbound.decrypt(forged), 'forged Megolm message');
      checkEqual(
        text(inbound.decrypt(message).plaintext),
        'group secret',
        'genuine message decrypts',
      );
    },
  },
  {
    id: '6a',
    title: 'Megolm membership change: room key over Olm; a removed member is locked out',
    run(provider) {
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
      checkEqual(text(bobInbound.decrypt(hello).plaintext), 'hello group', 'bob reads');
      checkEqual(text(carolInbound.decrypt(hello).plaintext), 'hello group', 'carol reads');

      // Carol is removed: Alice rotates and shares the new key with Bob only.
      const rotated = provider.createOutboundGroupSession();
      check(rotated.sessionId() !== first.sessionId(), 'rotation creates a new session');
      const bobRotated = shareKey('bob', rotated.sessionKey());
      const afterRemoval = rotated.encrypt(bytes('without carol'));
      checkEqual(
        text(bobRotated.decrypt(afterRemoval).plaintext),
        'without carol',
        'remaining member reads after rotation',
      );
      checkThrows(() => carolInbound.decrypt(afterRemoval), 'removed member decrypting');
    },
  },
  {
    id: '6b',
    title: 'Megolm reports the message index so the engine can reject replays',
    run(provider) {
      const outbound = provider.createOutboundGroupSession();
      const inbound = provider.createInboundGroupSession(outbound.sessionKey());
      const message = outbound.encrypt(bytes('x'));
      // Megolm itself accepts a second decryption; the (sessionId, index) check is the
      // message engine's job (ADR 0003).
      checkEqual(inbound.decrypt(message).messageIndex, 0, 'first decryption index');
      checkEqual(inbound.decrypt(message).messageIndex, 0, 'repeat decryption index');
    },
  },
  {
    id: '7',
    title: 'A new member gets the key at the current index and cannot read earlier messages',
    run(provider) {
      const outbound = provider.createOutboundGroupSession();
      const bob = provider.createInboundGroupSession(outbound.sessionKey());
      const earlier = [outbound.encrypt(bytes('m0')), outbound.encrypt(bytes('m1'))];
      checkEqual(outbound.messageIndex(), 2, 'outbound index advanced');

      const viaSessionKey = provider.createInboundGroupSession(outbound.sessionKey());
      const exported = bob.exportAt(2);
      if (!exported) throw new Error('export failed');
      const viaExport = provider.importInboundGroupSession(exported);

      const later = outbound.encrypt(bytes('m2'));
      for (const dave of [viaSessionKey, viaExport]) {
        checkEqual(dave.firstKnownIndex(), 2, 'new member starts at the current index');
        for (const message of earlier) {
          checkThrows(() => dave.decrypt(message), 'new member reading an earlier message');
        }
        checkEqual(text(dave.decrypt(later).plaintext), 'm2', 'new member reads later messages');
      }
      check(bob.exportAt(0) !== undefined, 'an earlier member can export from index 0');
    },
  },
  {
    id: '8a',
    title: 'Pickles round-trip every object, which keeps working afterwards',
    run(provider) {
      const alice = provider.createAccount();
      const bob = provider.createAccount();
      const oneTimeKey = claimOneTimeKey(bob);
      const bobRestored = provider.restoreAccount(bob.pickle(pickleKey), pickleKey);
      checkEqual(bobRestored.identityKeys(), bob.identityKeys(), 'restored identity keys');

      // The restored account still holds the published one-time key.
      const { outbound, inbound } = connect(alice, bobRestored, oneTimeKey);
      const restoredInbound: OlmSession = provider.restoreSession(
        inbound.pickle(pickleKey),
        pickleKey,
      );
      const restoredOutbound: OlmSession = provider.restoreSession(
        outbound.pickle(pickleKey),
        pickleKey,
      );
      checkEqual(
        text(restoredOutbound.decrypt(restoredInbound.encrypt(bytes('after restore')))),
        'after restore',
        'restored Olm sessions talk',
      );

      const group = provider.createOutboundGroupSession();
      group.encrypt(bytes('advance'));
      const groupRestored = provider.restoreOutboundGroupSession(
        group.pickle(pickleKey),
        pickleKey,
      );
      checkEqual(groupRestored.messageIndex(), 1, 'restored outbound group index');
      const member = provider.createInboundGroupSession(group.sessionKey());
      const memberRestored = provider.restoreInboundGroupSession(
        member.pickle(pickleKey),
        pickleKey,
      );
      checkEqual(
        text(memberRestored.decrypt(groupRestored.encrypt(bytes('g'))).plaintext),
        'g',
        'restored group sessions talk',
      );
    },
  },
  {
    id: '8b',
    title: 'Pickles reject a wrong or malformed pickle key',
    run(provider) {
      const account = provider.createAccount();
      const { outbound } = connect(account, provider.createAccount());
      const group = provider.createOutboundGroupSession();
      const member = provider.createInboundGroupSession(group.sessionKey());

      checkThrows(
        () => provider.restoreAccount(account.pickle(pickleKey), wrongPickleKey),
        'account restored with the wrong key',
      );
      checkThrows(
        () => provider.restoreSession(outbound.pickle(pickleKey), wrongPickleKey),
        'session restored with the wrong key',
      );
      checkThrows(
        () => provider.restoreOutboundGroupSession(group.pickle(pickleKey), wrongPickleKey),
        'outbound group session restored with the wrong key',
      );
      checkThrows(
        () => provider.restoreInboundGroupSession(member.pickle(pickleKey), wrongPickleKey),
        'inbound group session restored with the wrong key',
      );
      checkThrows(() => account.pickle(new Uint8Array(16)), 'pickling with a 16-byte key');
    },
  },
  {
    id: '9',
    title: "Multi-device fan-out to Alice's devices and Bob's own other device",
    run(provider) {
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
      checkEqual(
        Object.fromEntries(delivered),
        { alicePhone: 'fan-out', aliceWeb: 'fan-out', bobWeb: 'fan-out' },
        'every device decrypts its copy',
      );
    },
  },
  {
    id: 'sig',
    title: 'Strict Ed25519 signature verification',
    run(provider) {
      const account = provider.createAccount();
      const { ed25519 } = account.identityKeys();
      const signature = account.sign(bytes('device keys'));
      check(provider.verifyEd25519(ed25519, bytes('device keys'), signature), 'valid signature');
      check(
        !provider.verifyEd25519(ed25519, bytes('device keyz'), signature),
        'signature over other bytes',
      );
      check(
        !provider.verifyEd25519('not-a-key', bytes('device keys'), signature),
        'malformed public key',
      );
    },
  },
  {
    id: 'idk',
    title: 'Account identity key certifies a device; export and restore keep it (Phase 6)',
    run(provider) {
      const identity = provider.createSigningKey();
      const device = provider.createAccount();
      const certificate = bytes(`certificate:${device.identityKeys().ed25519}`);
      const signature = identity.sign(certificate);
      check(
        provider.verifyEd25519(identity.publicKey(), certificate, signature),
        'certificate verifies with the identity key',
      );
      check(
        !provider.verifyEd25519(device.identityKeys().ed25519, certificate, signature),
        'the device key does not verify it',
      );

      const restored = provider.restoreSigningKey(identity.exportSecret());
      checkEqual(restored.publicKey(), identity.publicKey(), 'restored public key');
      checkEqual(restored.sign(certificate), signature, 'Ed25519 signatures are deterministic');
      checkThrows(() => provider.restoreSigningKey('AAAA'), 'a malformed secret');
      const other = provider.createSigningKey();
      check(other.publicKey() !== identity.publicKey(), 'fresh keys differ');
      for (const disposable of [identity, restored, other, device]) disposable.dispose();
    },
  },
];
