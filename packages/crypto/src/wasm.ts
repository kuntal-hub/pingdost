/**
 * WASM `CryptoProvider` for web and Node: vodozemac compiled to wasm32 and bound with
 * uniffi-bindgen-react-native `wasm2` (ADR 0003). Only this file touches `./generated`.
 */
import type { WasmSource } from '@ubjs/wasm';

import { CryptoOperationError } from './errors';
import * as generated from './generated/index';
import type * as types from './types';

const IMPLEMENTATION = 'pingdost-crypto/vodozemac-0.11.1 (wasm)';

/** Converts Rust-side failures into `CryptoOperationError` so callers never see generated types. */
function call<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (generated.CryptoError.instanceOf(error)) {
      throw new CryptoOperationError(error.tag, error.message);
    }
    throw new CryptoOperationError('Internal', 'unexpected crypto failure');
  }
}

const toBuffer = (data: Uint8Array): ArrayBuffer => data.slice().buffer;
const fromBuffer = (data: ArrayBuffer): Uint8Array => new Uint8Array(data);

function toWire(message: types.OlmCiphertext): generated.OlmCiphertext {
  return {
    messageType:
      message.type === 'prekey' ? generated.OlmMessageType.PreKey : generated.OlmMessageType.Normal,
    body: toBuffer(message.body),
  };
}

function fromWire(message: generated.OlmCiphertext): types.OlmCiphertext {
  return {
    type: message.messageType === generated.OlmMessageType.PreKey ? 'prekey' : 'normal',
    body: fromBuffer(message.body),
  };
}

class WasmOlmAccount implements types.OlmAccount {
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
    return new WasmOlmSession(
      call(() => this.inner.createOutboundSession(theirIdentityKey, theirOneTimeKey)),
    );
  }
  createInboundSession(theirIdentityKey: string, message: types.OlmCiphertext) {
    const result = call(() => this.inner.createInboundSession(theirIdentityKey, toWire(message)));
    return { session: new WasmOlmSession(result.session), plaintext: fromBuffer(result.plaintext) };
  }
  pickle(pickleKey: Uint8Array): string {
    return call(() => this.inner.pickle(toBuffer(pickleKey)));
  }
  dispose(): void {
    if (generated.Account.instanceOf(this.inner)) this.inner.uniffiDestroy();
  }
}

class WasmOlmSession implements types.OlmSession {
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
    if (generated.Session.instanceOf(this.inner)) this.inner.uniffiDestroy();
  }
}

class WasmMegolmOutboundSession implements types.MegolmOutboundSession {
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
    if (generated.GroupSession.instanceOf(this.inner)) this.inner.uniffiDestroy();
  }
}

class WasmMegolmInboundSession implements types.MegolmInboundSession {
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
    if (generated.InboundGroupSession.instanceOf(this.inner)) this.inner.uniffiDestroy();
  }
}

const provider: types.CryptoProvider = {
  implementation: IMPLEMENTATION,

  createAccount: () => new WasmOlmAccount(call(() => new generated.Account())),
  restoreAccount: (pickle, pickleKey) =>
    new WasmOlmAccount(call(() => generated.Account.fromPickle(pickle, toBuffer(pickleKey)))),
  restoreSession: (pickle, pickleKey) =>
    new WasmOlmSession(call(() => generated.Session.fromPickle(pickle, toBuffer(pickleKey)))),
  prekeyMessageSessionId: (message) =>
    call(() => generated.prekeyMessageSessionId(toWire(message))),

  createOutboundGroupSession: () =>
    new WasmMegolmOutboundSession(call(() => new generated.GroupSession())),
  restoreOutboundGroupSession: (pickle, pickleKey) =>
    new WasmMegolmOutboundSession(
      call(() => generated.GroupSession.fromPickle(pickle, toBuffer(pickleKey))),
    ),
  createInboundGroupSession: (sessionKey) =>
    new WasmMegolmInboundSession(call(() => new generated.InboundGroupSession(sessionKey))),
  importInboundGroupSession: (exportedKey) =>
    new WasmMegolmInboundSession(
      call(() => generated.InboundGroupSession.fromExportedKey(exportedKey)),
    ),
  restoreInboundGroupSession: (pickle, pickleKey) =>
    new WasmMegolmInboundSession(
      call(() => generated.InboundGroupSession.fromPickle(pickle, toBuffer(pickleKey))),
    ),

  verifyEd25519: (publicKey, message, signature) => {
    try {
      call(() => generated.ed25519Verify(publicKey, toBuffer(message), signature));
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Loads the WASM module (once) and returns the provider.
 *
 * The default `source` is the module staged beside the generated bindings; Vite rewrites
 * this `new URL(..., import.meta.url)` pattern and Node reads it from disk.
 */
export async function createWasmCryptoProvider(
  source: WasmSource = new URL('./generated/pingdost_crypto.wasm', import.meta.url),
): Promise<types.CryptoProvider> {
  await generated.uniffiInitAsync(source);
  return provider;
}
