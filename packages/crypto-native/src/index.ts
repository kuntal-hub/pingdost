// @pingdost/crypto-native: the CryptoProvider for React Native (Android first). The same
// Rust crate as the WASM build, shipped as lib<name>.so and loaded through the
// @ubjs/react-native JSI player (ADR 0005). Only this file touches `./generated`.
import { createBindingsProvider, type CryptoProvider } from '@pingdost/crypto/core';

import * as bindings from './generated/entry';

const IMPLEMENTATION = 'pingdost-crypto/vodozemac-0.11.1 (jsi2)';

let provider: CryptoProvider | undefined;

/**
 * Returns the native provider. Synchronous: the library is opened lazily on first use, so
 * the first crypto call pays the load cost (measured in ADR 0005).
 */
export function createNativeCryptoProvider(): CryptoProvider {
  provider ??= createBindingsProvider(bindings, IMPLEMENTATION);
  return provider;
}
