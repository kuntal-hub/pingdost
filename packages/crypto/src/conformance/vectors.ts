/**
 * Deterministic cross-implementation vectors: created once with the WASM build
 * (`scripts/make-vectors.ts`), stored in `@pingdost/test-fixtures`, and checked by every
 * implementation. Olm and Megolm encryption is randomized, so the vectors cover the
 * deterministic parts: restoring pickles, Ed25519 signing, pre-key and Megolm decryption.
 *
 * The keys inside are throwaway test keys, never used outside tests.
 */
import type { CryptoProvider, IdentityKeys, OlmMessageType } from '../types';
import { fromBase64, toBase64 } from './base64';
import { checkEqual, check, describeError, type StepResult } from './check';
import { bytes, claimOneTimeKey, text } from './scenarios';

export interface CryptoVectors {
  implementation: string;
  /** base64; the key every pickle below is encrypted with. */
  pickleKey: string;
  signing: {
    accountPickle: string;
    identityKeys: IdentityKeys;
    message: string;
    signature: string;
  };
  olmPrekey: {
    receiverAccountPickle: string;
    senderIdentityKey: string;
    message: { type: OlmMessageType; body: string };
    plaintext: string;
  };
  megolm: {
    sessionKey: string;
    sessionId: string;
    messages: { index: number; ciphertext: string; plaintext: string }[];
  };
}

export function createVectors(provider: CryptoProvider): CryptoVectors {
  const pickleKey = crypto.getRandomValues(new Uint8Array(32));

  const signer = provider.createAccount();
  const message = 'pingdost device certificate vector';

  const receiver = provider.createAccount();
  const sender = provider.createAccount();
  const outbound = sender.createOutboundSession(
    receiver.identityKeys().curve25519,
    claimOneTimeKey(receiver),
  );
  const plaintext = 'olm pre-key vector';
  const prekey = outbound.encrypt(bytes(plaintext));

  const group = provider.createOutboundGroupSession();
  const sessionKey = group.sessionKey();
  const messages = ['megolm vector 0', 'megolm vector 1', 'megolm vector 2'].map((value) => ({
    index: group.messageIndex(),
    ciphertext: toBase64(group.encrypt(bytes(value))),
    plaintext: value,
  }));

  return {
    implementation: provider.implementation,
    pickleKey: toBase64(pickleKey),
    signing: {
      accountPickle: signer.pickle(pickleKey),
      identityKeys: signer.identityKeys(),
      message,
      signature: signer.sign(bytes(message)),
    },
    olmPrekey: {
      receiverAccountPickle: receiver.pickle(pickleKey),
      senderIdentityKey: sender.identityKeys().curve25519,
      message: { type: prekey.type, body: toBase64(prekey.body) },
      plaintext,
    },
    megolm: { sessionKey, sessionId: group.sessionId(), messages },
  };
}

function step(id: string, title: string, run: () => void): StepResult {
  try {
    run();
    return { id, title, ok: true };
  } catch (error) {
    return { id, title, ok: false, detail: describeError(error) };
  }
}

export function verifyVectors(provider: CryptoProvider, vectors: CryptoVectors): StepResult[] {
  const pickleKey = fromBase64(vectors.pickleKey);
  return [
    step('vector-signing', 'Restore a pickled account; Ed25519 signature matches', () => {
      const { signing } = vectors;
      const account = provider.restoreAccount(signing.accountPickle, pickleKey);
      checkEqual(account.identityKeys(), signing.identityKeys, 'identity keys');
      checkEqual(account.sign(bytes(signing.message)), signing.signature, 'signature');
      check(
        provider.verifyEd25519(
          signing.identityKeys.ed25519,
          bytes(signing.message),
          signing.signature,
        ),
        'signature verifies',
      );
    }),
    step('vector-olm', 'Restore a pickled account; decrypt a stored pre-key message', () => {
      const { olmPrekey } = vectors;
      const receiver = provider.restoreAccount(olmPrekey.receiverAccountPickle, pickleKey);
      const { plaintext } = receiver.createInboundSession(olmPrekey.senderIdentityKey, {
        type: olmPrekey.message.type,
        body: fromBase64(olmPrekey.message.body),
      });
      checkEqual(text(plaintext), olmPrekey.plaintext, 'pre-key plaintext');
    }),
    step('vector-megolm', 'Decrypt stored Megolm messages from a session key', () => {
      const { megolm } = vectors;
      const inbound = provider.createInboundGroupSession(megolm.sessionKey);
      checkEqual(inbound.sessionId(), megolm.sessionId, 'session ID');
      for (const message of megolm.messages) {
        const result = inbound.decrypt(fromBase64(message.ciphertext));
        checkEqual(result.messageIndex, message.index, 'message index');
        checkEqual(text(result.plaintext), message.plaintext, 'Megolm plaintext');
      }
    }),
  ];
}
