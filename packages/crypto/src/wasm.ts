/**
 * WASM `CryptoProvider` for web and Node: vodozemac compiled to wasm32 and bound with
 * uniffi-bindgen-react-native `wasm2` (ADR 0003). Only this file loads `./generated`.
 */
import type { WasmSource } from '@ubjs/wasm';

import { createBindingsProvider } from './bindings';
import * as generated from './generated/index';
import type { CryptoProvider } from './types';

const IMPLEMENTATION = 'pingdost-crypto/vodozemac-0.11.1 (wasm)';

let provider: CryptoProvider | undefined;

/**
 * Loads the WASM module (once) and returns the provider.
 *
 * The default `source` is the module staged beside the generated bindings; Vite rewrites
 * this `new URL(..., import.meta.url)` pattern and Node reads it from disk.
 */
export async function createWasmCryptoProvider(
  source: WasmSource = new URL('./generated/pingdost_crypto.wasm', import.meta.url),
): Promise<CryptoProvider> {
  await generated.uniffiInitAsync(source);
  provider ??= createBindingsProvider(generated, IMPLEMENTATION);
  return provider;
}
