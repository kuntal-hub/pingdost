// Web APIs that shared packages expect on `globalThis` and Hermes may lack. Imported first by
// the root layout.
// - `uuid` (through `@pingdost/protocol/ids`) needs `crypto.getRandomValues`, which
//   expo-crypto serves from the platform CSPRNG.
// - protobuf-es decodes strings with `new TextDecoder('utf-8', { fatal: true })` (ADR 0006
//   point 11). A missing decoder, or one that ignores `fatal`, is replaced by ours (ADR 0012).
import { getRandomValues } from 'expo-crypto';

import { hasStrictTextDecoder, Utf8TextDecoder } from './utils/utf8-decoder';

const scope = globalThis as { crypto?: { getRandomValues?: unknown }; TextDecoder?: unknown };
scope.crypto ??= {};
if (typeof scope.crypto.getRandomValues !== 'function') {
  scope.crypto.getRandomValues = getRandomValues;
}

const strictNative = hasStrictTextDecoder(scope);
if (!strictNative) scope.TextDecoder = Utf8TextDecoder;
if (__DEV__) {
  console.log(
    `[polyfills] TextDecoder: ${strictNative ? 'native (fatal supported)' : 'PingDost fallback'}`,
  );
}
