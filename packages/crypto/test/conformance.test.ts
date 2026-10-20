/**
 * The full CryptoProvider conformance suite (`runCryptoConformance`) on the WASM provider.
 * The phone runs the same suite on the native provider.
 */
import { createHash } from 'node:crypto';

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { beforeAll, describe, expect, it } from 'vitest';

import attachmentVectors from '@pingdost/test-fixtures/crypto/attachment-stream-v1.json';
import storedVectors from '@pingdost/test-fixtures/crypto/vodozemac-0.11.1.json';

import {
  allScenarios,
  attachmentVectorPlaintext,
  fromBase64,
  runCryptoConformance,
  type AttachmentVectors,
  type CryptoVectors,
} from '../src/conformance/index';
import { createWasmCryptoProvider } from '../src/index';
import type { CryptoProvider } from '../src/index';

const vectors = storedVectors as CryptoVectors;
const attachment = attachmentVectors as AttachmentVectors;
let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

describe('runCryptoConformance (WASM)', () => {
  it('passes every scenario and stored vector', () => {
    const report = runCryptoConformance(provider, vectors, attachment);
    expect(report.implementation).toContain('wasm');
    expect(report.steps.filter((step) => !step.ok)).toEqual([]);
    expect(report.steps).toHaveLength(allScenarios.length + 3 + 2);
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

describe('attachment vectors against an independent XChaCha20-Poly1305', () => {
  // STREAM BE32 (ADR 0004): nonce = 19-byte prefix ‖ big-endian 32-bit index ‖ last flag.
  const nonce = (index: number, last: boolean) => {
    const out = new Uint8Array(24);
    out.set(fromBase64(attachment.noncePrefix));
    new DataView(out.buffer).setUint32(19, index, false);
    out[23] = last ? 1 : 0;
    return out;
  };
  const key = fromBase64(attachment.key);
  const plaintext = attachmentVectorPlaintext(attachment.plaintextLength);

  it('produces the same chunks with @noble/ciphers', () => {
    const first = xchacha20poly1305(key, nonce(0, false)).encrypt(plaintext.subarray(0, 65_536));
    expect(createHash('sha256').update(first).digest('base64')).toBe(attachment.chunkSha256[0]);
    const last = xchacha20poly1305(key, nonce(1, true)).encrypt(plaintext.subarray(65_536));
    expect(Buffer.from(last).toString('base64')).toBe(attachment.lastChunk);
  });
});
