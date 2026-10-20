// The WASM crypto provider (vodozemac; ADR 0003), loaded on first use as its own chunk so the
// pairing screen appears before the module downloads. A failed load can be retried.
import type { CryptoProvider } from '@pingdost/crypto/core';

let loading: Promise<CryptoProvider> | undefined;

export function cryptoProvider(): Promise<CryptoProvider> {
  loading ??= import('@pingdost/crypto')
    .then((module) => module.createWasmCryptoProvider())
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}
