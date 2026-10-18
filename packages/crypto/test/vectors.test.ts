import { beforeAll, describe, expect, it } from 'vitest';

import storedVectors from '@pingdost/test-fixtures/crypto/vodozemac-0.11.1.json';

import { createVectors, verifyVectors, type CryptoVectors } from '../src/conformance/index';
import { createWasmCryptoProvider } from '../src/index';
import type { CryptoProvider } from '../src/index';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

describe('deterministic crypto vectors', () => {
  it('verifies the stored vectors', () => {
    const steps = verifyVectors(provider, storedVectors as CryptoVectors);
    expect(steps).toHaveLength(3);
    for (const step of steps) expect(step).toMatchObject({ ok: true });
  });

  it('verifies freshly created vectors', () => {
    for (const step of verifyVectors(provider, createVectors(provider))) {
      expect(step).toMatchObject({ ok: true });
    }
  });

  it('fails on a tampered vector', () => {
    const vectors = createVectors(provider);
    vectors.signing.signature = createVectors(provider).signing.signature;
    const [signing] = verifyVectors(provider, vectors);
    expect(signing).toMatchObject({ id: 'vector-signing', ok: false });
  });
});
