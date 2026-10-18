// @pingdost/crypto/conformance: provider-independent conformance scenarios, deterministic
// vectors and the phone ↔ Node interop protocol (Phase 3). Test and dev-screen code only.
import type { CryptoProvider } from '../types';
import { describeError, type StepResult } from './check';
import { scenarios } from './scenarios';

export { fromBase64, toBase64 } from './base64';
export { ConformanceError, describeError } from './check';
export type { StepResult } from './check';
export * from './interop';
export { scenarios } from './scenarios';
export type { Scenario } from './scenarios';
export { createVectors, verifyVectors } from './vectors';
export type { CryptoVectors } from './vectors';

/** Runs every scenario against `provider`, reporting each as a step. */
export function runScenarios(provider: CryptoProvider): StepResult[] {
  return scenarios.map(({ id, title, run }) => {
    try {
      run(provider);
      return { id, title, ok: true };
    } catch (error) {
      return { id, title, ok: false, detail: describeError(error) };
    }
  });
}
