/**
 * The `CryptoProvider` over uniffi-bindgen-react-native bindings. The `wasm2` bindings
 * (web, Node) and the `jsi2` bindings (`@pingdost/crypto-native`, Android) are generated
 * from the same crate and have the same API, so both providers share this wrapper (ADR 0005).
 *
 * Only runtime values from the `bindings` argument are used: the import below is type-only,
 * so a React Native bundle never pulls in the WASM module.
 */
import { CryptoOperationError } from './errors';
import type * as generated from './generated/index';
import type * as types from './types';

/** The parts of a generated bindings module that the wrapper uses. */
export type UniffiBindings = Pick<
  typeof generated,
  | 'Account'
  | 'Session'
  | 'GroupSession'
  | 'InboundGroupSession'
  | 'SigningKey'
  | 'CryptoError'
  | 'OlmMessageType'
  | 'prekeyMessageSessionId'
  | 'ed25519Verify'
  | 'AttachmentEncryptor'
  | 'attachmentDecryptChunk'
  | 'sha256'
  | 'Sha256Hasher'
>;

const toBuffer = (data: Uint8Array): ArrayBuffer => data.slice().buffer;
const fromBuffer = (data: ArrayBuffer): Uint8Array => new Uint8Array(data);

export function createBindingsProvider(
  bindings: UniffiBindings,
  implementation: string,
): types.CryptoProvider {
  /** Converts Rust-side failures into `CryptoOperationError` so callers never see generated types. */
  function call<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (bindings.CryptoError.instanceOf(error)) {
        throw new CryptoOperationError(error.tag, error.message);
      }
      throw new CryptoOperationError('Internal', 'unexpected crypto failure');
    }
  }

  function toWire(message: types.OlmCiphertext): generated.OlmCiphertext {
    return {
      messageType:
        message.type === 'prekey' ? bindings.OlmMessageType.PreKey : bindings.OlmMessageType.Normal,
      body: toBuffer(message.body),
    };
  }

  function fromWire(message: generated.OlmCiphertext): types.OlmCiphertext {
    return {
      type: message.messageType === bindings.OlmMessageType.PreKey ? 'prekey' : 'normal',
      body: fromBuffer(message.body),
    };
  }

  class OlmAccount implements types.OlmAccount {
    constructor(private readonly inner: generated.AccountLike) {}

    identityKeys(): types.IdentityKeys {
      return call(() => this.inner.identityKeys());
    }
    sign(message: Uint8Array): string {
      return call(() => this.inner.sign(toBuffer(message)));
    }
    maxNumberOfOneTimeKeys(): number {
      return call(() => this.inner.maxNumberOfOneTimeKeys());
    }
    generateOneTimeKeys(count: number): void {
      call(() => this.inner.generateOneTimeKeys(count));
    }
    oneTimeKeys(): types.OneTimeKey[] {
      return call(() => this.inner.oneTimeKeys());
    }
    markKeysAsPublished(): void {
      call(() => this.inner.markKeysAsPublished());
    }
    generateFallbackKey(): void {
      call(() => this.inner.generateFallbackKey());
    }
    fallbackKey(): types.OneTimeKey | undefined {
      return call(() => this.inner.fallbackKey());
    }
    createOutboundSession(theirIdentityKey: string, theirOneTimeKey: string): types.OlmSession {
      return new OlmSession(
        call(() => this.inner.createOutboundSession(theirIdentityKey, theirOneTimeKey)),
      );
    }
    createInboundSession(theirIdentityKey: string, message: types.OlmCiphertext) {
      const result = call(() => this.inner.createInboundSession(theirIdentityKey, toWire(message)));
      return { session: new OlmSession(result.session), plaintext: fromBuffer(result.plaintext) };
    }
    pickle(pickleKey: Uint8Array): string {
      return call(() => this.inner.pickle(toBuffer(pickleKey)));
    }
    dispose(): void {
      if (bindings.Account.instanceOf(this.inner)) this.inner.uniffiDestroy();
    }
  }

  class OlmSession implements types.OlmSession {
    constructor(private readonly inner: generated.SessionLike) {}

    sessionId(): string {
      return call(() => this.inner.sessionId());
    }
    hasReceivedMessage(): boolean {
      return call(() => this.inner.hasReceivedMessage());
    }
    encrypt(plaintext: Uint8Array): types.OlmCiphertext {
      return fromWire(call(() => this.inner.encrypt(toBuffer(plaintext))));
    }
    decrypt(message: types.OlmCiphertext): Uint8Array {
      return fromBuffer(call(() => this.inner.decrypt(toWire(message))));
    }
    pickle(pickleKey: Uint8Array): string {
      return call(() => this.inner.pickle(toBuffer(pickleKey)));
    }
    dispose(): void {
      if (bindings.Session.instanceOf(this.inner)) this.inner.uniffiDestroy();
    }
  }

  class MegolmOutboundSession implements types.MegolmOutboundSession {
    constructor(private readonly inner: generated.GroupSessionLike) {}

    sessionId(): string {
      return call(() => this.inner.sessionId());
    }
    sessionKey(): string {
      return call(() => this.inner.sessionKey());
    }
    messageIndex(): number {
      return call(() => this.inner.messageIndex());
    }
    encrypt(plaintext: Uint8Array): Uint8Array {
      return fromBuffer(call(() => this.inner.encrypt(toBuffer(plaintext))));
    }
    pickle(pickleKey: Uint8Array): string {
      return call(() => this.inner.pickle(toBuffer(pickleKey)));
    }
    dispose(): void {
      if (bindings.GroupSession.instanceOf(this.inner)) this.inner.uniffiDestroy();
    }
  }

  class MegolmInboundSession implements types.MegolmInboundSession {
    constructor(private readonly inner: generated.InboundGroupSessionLike) {}

    sessionId(): string {
      return call(() => this.inner.sessionId());
    }
    firstKnownIndex(): number {
      return call(() => this.inner.firstKnownIndex());
    }
    decrypt(message: Uint8Array) {
      const result = call(() => this.inner.decrypt(toBuffer(message)));
      return { plaintext: fromBuffer(result.plaintext), messageIndex: result.messageIndex };
    }
    exportAt(index: number): string | undefined {
      return call(() => this.inner.exportAt(index));
    }
    pickle(pickleKey: Uint8Array): string {
      return call(() => this.inner.pickle(toBuffer(pickleKey)));
    }
    dispose(): void {
      if (bindings.InboundGroupSession.instanceOf(this.inner)) this.inner.uniffiDestroy();
    }
  }

  class SigningKey implements types.SigningKey {
    constructor(private readonly inner: generated.SigningKeyLike) {}

    publicKey(): string {
      return call(() => this.inner.publicKey());
    }
    sign(message: Uint8Array): string {
      return call(() => this.inner.sign(toBuffer(message)));
    }
    exportSecret(): string {
      return call(() => this.inner.exportSecret());
    }
    dispose(): void {
      if (bindings.SigningKey.instanceOf(this.inner)) this.inner.uniffiDestroy();
    }
  }

  class AttachmentEncryptor implements types.AttachmentEncryptor {
    constructor(private readonly inner: generated.AttachmentEncryptorLike) {}

    encryptChunk(plaintext: Uint8Array, last: boolean) {
      const chunk = call(() => this.inner.encryptChunk(toBuffer(plaintext), last));
      return { ciphertext: fromBuffer(chunk.ciphertext), sha256: fromBuffer(chunk.sha256) };
    }
    finish(): types.AttachmentDigests {
      const digests = call(() => this.inner.finish());
      return {
        chunkCount: digests.chunkCount,
        plaintextSize: Number(digests.plaintextSize),
        ciphertextSize: Number(digests.ciphertextSize),
        ciphertextSha256: fromBuffer(digests.ciphertextSha256),
        chunkHashListSha256: fromBuffer(digests.chunkHashListSha256),
      };
    }
    dispose(): void {
      if (bindings.AttachmentEncryptor.instanceOf(this.inner)) this.inner.uniffiDestroy();
    }
  }

  class Sha256Hasher implements types.Sha256Hasher {
    constructor(private readonly inner: generated.Sha256HasherLike) {}

    update(data: Uint8Array): void {
      call(() => this.inner.update(toBuffer(data)));
    }
    digest(): Uint8Array {
      return fromBuffer(call(() => this.inner.digest()));
    }
    dispose(): void {
      if (bindings.Sha256Hasher.instanceOf(this.inner)) this.inner.uniffiDestroy();
    }
  }

  return {
    implementation,

    createAccount: () => new OlmAccount(call(() => new bindings.Account())),
    restoreAccount: (pickle, pickleKey) =>
      new OlmAccount(call(() => bindings.Account.fromPickle(pickle, toBuffer(pickleKey)))),
    restoreSession: (pickle, pickleKey) =>
      new OlmSession(call(() => bindings.Session.fromPickle(pickle, toBuffer(pickleKey)))),
    prekeyMessageSessionId: (message) =>
      call(() => bindings.prekeyMessageSessionId(toWire(message))),

    createOutboundGroupSession: () =>
      new MegolmOutboundSession(call(() => new bindings.GroupSession())),
    restoreOutboundGroupSession: (pickle, pickleKey) =>
      new MegolmOutboundSession(
        call(() => bindings.GroupSession.fromPickle(pickle, toBuffer(pickleKey))),
      ),
    createInboundGroupSession: (sessionKey) =>
      new MegolmInboundSession(call(() => new bindings.InboundGroupSession(sessionKey))),
    importInboundGroupSession: (exportedKey) =>
      new MegolmInboundSession(
        call(() => bindings.InboundGroupSession.fromExportedKey(exportedKey)),
      ),
    restoreInboundGroupSession: (pickle, pickleKey) =>
      new MegolmInboundSession(
        call(() => bindings.InboundGroupSession.fromPickle(pickle, toBuffer(pickleKey))),
      ),

    createSigningKey: () => new SigningKey(call(() => new bindings.SigningKey())),
    restoreSigningKey: (secret) =>
      new SigningKey(call(() => bindings.SigningKey.fromSecret(secret))),

    verifyEd25519: (publicKey, message, signature) => {
      try {
        call(() => bindings.ed25519Verify(publicKey, toBuffer(message), signature));
        return true;
      } catch {
        return false;
      }
    },

    createAttachmentEncryptor: (key, noncePrefix) =>
      new AttachmentEncryptor(
        call(() => new bindings.AttachmentEncryptor(toBuffer(key), toBuffer(noncePrefix))),
      ),
    decryptAttachmentChunk: (key, noncePrefix, index, last, ciphertext) =>
      fromBuffer(
        call(() =>
          bindings.attachmentDecryptChunk(
            toBuffer(key),
            toBuffer(noncePrefix),
            index,
            last,
            toBuffer(ciphertext),
          ),
        ),
      ),
    sha256: (data) => fromBuffer(call(() => bindings.sha256(toBuffer(data)))),
    createSha256: () => new Sha256Hasher(call(() => new bindings.Sha256Hasher())),
  };
}
