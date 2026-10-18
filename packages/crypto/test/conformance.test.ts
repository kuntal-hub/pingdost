/**
 * The full CryptoProvider conformance suite (`runCryptoConformance`) on the WASM provider.
 * The phone runs the same suite on the native provider.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import storedVectors from '@pingdost/test-fixtures/crypto/vodozemac-0.11.1.json';

import { runCryptoConformance, scenarios, type CryptoVectors } from '../src/conformance/index';
import { createWasmCryptoProvider } from '../src/index';
import type { CryptoProvider } from '../src/index';

const vectors = storedVectors as CryptoVectors;
let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

describe('runCryptoConformance (WASM)', () => {
  it('passes every scenario and stored vector', () => {
    const report = runCryptoConformance(provider, vectors);
    expect(report.implementation).toContain('wasm');
    expect(report.steps.filter((step) => !step.ok)).toEqual([]);
    expect(report.steps).toHaveLength(scenarios.length + 3);
    expect(report.ok).toBe(true);
  });

  it('fails when a provider misbehaves', () => {
    const lying: CryptoProvider = { ...provider, verifyEd25519: () => false };
    const report = runCryptoConformance(lying, vectors);
    expect(report.ok).toBe(false);
    expect(report.steps.filter((step) => !step.ok).map((step) => step.id)).toContain(
      'vector-signing',
    );
  });
});
