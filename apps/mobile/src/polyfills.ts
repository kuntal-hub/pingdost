// Web APIs that shared packages expect on `globalThis` and Hermes may lack. Imported first by
// the root layout. `uuid` (through `@pingdost/protocol/ids`) needs `crypto.getRandomValues`,
// which expo-crypto serves from the platform CSPRNG. Phase 10 adds `TextDecoder` for
// protobuf-es (ADR 0006 point 11).
import { getRandomValues } from 'expo-crypto';

const scope = globalThis as { crypto?: { getRandomValues?: unknown } };
scope.crypto ??= {};
if (typeof scope.crypto.getRandomValues !== 'function') {
  scope.crypto.getRandomValues = getRandomValues;
}
