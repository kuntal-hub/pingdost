/**
 * Attachment encryption conformance (ADR 0004): runner-independent scenarios and stored
 * vectors. XChaCha20-Poly1305 STREAM is deterministic for a given key and nonce prefix, so
 * the vectors pin the exact ciphertext hashes every provider must produce.
 */
import type { CryptoProvider } from '../types';
import { fromBase64, toBase64 } from './base64';
import { check, checkEqual, checkThrows, describeError, type StepResult } from './check';
import type { Scenario } from './scenarios';

export const ATTACHMENT_CHUNK_SIZE = 65_536;

export interface AttachmentVectors {
  scheme: 'xchacha20poly1305-stream-be32-64k/1';
  /** base64; throwaway test values. */
  key: string;
  noncePrefix: string;
  /** The plaintext is `attachmentVectorPlaintext(plaintextLength)`. */
  plaintextLength: number;
  /** base64 SHA-256 of each ciphertext chunk. */
  chunkSha256: string[];
  ciphertextSha256: string;
  chunkHashListSha256: string;
  /** base64 ciphertext of the (short) last chunk. */
  lastChunk: string;
}

/** A fixed, recognisable plaintext. */
export function attachmentVectorPlaintext(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7) % 256);
}

/** Splits into 64 KiB chunks; there is always a last chunk (empty after an exact multiple). */
export function plaintextChunks(data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += ATTACHMENT_CHUNK_SIZE) {
    chunks.push(data.subarray(offset, offset + ATTACHMENT_CHUNK_SIZE));
  }
  if (data.length % ATTACHMENT_CHUNK_SIZE === 0) chunks.push(new Uint8Array(0));
  return chunks;
}

function encryptAll(
  provider: CryptoProvider,
  key: Uint8Array,
  prefix: Uint8Array,
  data: Uint8Array,
) {
  const encryptor = provider.createAttachmentEncryptor(key, prefix);
  try {
    const chunks = plaintextChunks(data);
    const out = chunks.map((chunk, i) => encryptor.encryptChunk(chunk, i === chunks.length - 1));
    return { chunks: out, digests: encryptor.finish() };
  } finally {
    encryptor.dispose();
  }
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const attachmentScenarios: Scenario[] = [
  {
    id: 'sha256-known-answer',
    title: 'SHA-256 matches the FIPS 180-2 "abc" vector, one-shot and incremental',
    run: (provider) => {
      const expected = 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';
      checkEqual(toBase64(provider.sha256(new TextEncoder().encode('abc'))), expected, 'one-shot');
      const hasher = provider.createSha256();
      try {
        hasher.update(new TextEncoder().encode('a'));
        hasher.update(new TextEncoder().encode('bc'));
        checkEqual(toBase64(hasher.digest()), expected, 'incremental');
      } finally {
        hasher.dispose();
      }
    },
  },
  {
    id: 'attachment-roundtrip',
    title: 'Attachment chunks decrypt by index in any order; digests match the ciphertext',
    run: (provider) => {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const prefix = crypto.getRandomValues(new Uint8Array(19));
      const data = attachmentVectorPlaintext(ATTACHMENT_CHUNK_SIZE * 2 + 999);
      const { chunks, digests } = encryptAll(provider, key, prefix, data);
      checkEqual(digests.chunkCount, 3, 'chunk count');
      checkEqual(digests.plaintextSize, data.length, 'plaintext size');
      checkEqual(digests.ciphertextSize, data.length + 3 * 16, 'ciphertext size');
      const plain: Uint8Array[] = [];
      for (const index of [2, 0, 1]) {
        plain[index] = provider.decryptAttachmentChunk(
          key,
          prefix,
          index,
          index === 2,
          chunks[index]!.ciphertext,
        );
      }
      checkEqual(toBase64(concat(plain)), toBase64(data), 'plaintext');
      const all = concat(chunks.map((c) => c.ciphertext));
      checkEqual(
        toBase64(digests.ciphertextSha256),
        toBase64(provider.sha256(all)),
        'ciphertext hash',
      );
      const list = concat(chunks.map((c) => c.sha256));
      checkEqual(
        toBase64(digests.chunkHashListSha256),
        toBase64(provider.sha256(list)),
        'chunk hash list hash',
      );
    },
  },
  {
    id: 'attachment-integrity',
    title: 'Truncated, reordered, altered or wrongly keyed attachment chunks are rejected',
    run: (provider) => {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const prefix = crypto.getRandomValues(new Uint8Array(19));
      const { chunks } = encryptAll(
        provider,
        key,
        prefix,
        attachmentVectorPlaintext(ATTACHMENT_CHUNK_SIZE * 2),
      );
      check(chunks.length === 3, 'an exact multiple ends with an empty last chunk');
      const decrypt = (index: number, last: boolean, data: Uint8Array, k = key) =>
        provider.decryptAttachmentChunk(k, prefix, index, last, data);
      checkThrows(() => decrypt(1, true, chunks[1]!.ciphertext), 'truncation (no last flag)');
      checkThrows(() => decrypt(0, false, chunks[1]!.ciphertext), 'chunk at another position');
      const altered = chunks[0]!.ciphertext.slice();
      altered[7] = (altered[7] ?? 0) ^ 1;
      checkThrows(() => decrypt(0, false, altered), 'altered chunk');
      checkThrows(
        () => decrypt(0, false, chunks[0]!.ciphertext, new Uint8Array(32)),
        'another key',
      );
    },
  },
];

export function createAttachmentVectors(provider: CryptoProvider): AttachmentVectors {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const prefix = crypto.getRandomValues(new Uint8Array(19));
  const plaintextLength = ATTACHMENT_CHUNK_SIZE + 1_000;
  const { chunks, digests } = encryptAll(
    provider,
    key,
    prefix,
    attachmentVectorPlaintext(plaintextLength),
  );
  return {
    scheme: 'xchacha20poly1305-stream-be32-64k/1',
    key: toBase64(key),
    noncePrefix: toBase64(prefix),
    plaintextLength,
    chunkSha256: chunks.map((c) => toBase64(c.sha256)),
    ciphertextSha256: toBase64(digests.ciphertextSha256),
    chunkHashListSha256: toBase64(digests.chunkHashListSha256),
    lastChunk: toBase64(chunks.at(-1)!.ciphertext),
  };
}

export function verifyAttachmentVectors(
  provider: CryptoProvider,
  vectors: AttachmentVectors,
): StepResult[] {
  const step = (id: string, title: string, run: () => void): StepResult => {
    try {
      run();
      return { id, title, ok: true };
    } catch (error) {
      return { id, title, ok: false, detail: describeError(error) };
    }
  };
  const key = fromBase64(vectors.key);
  const prefix = fromBase64(vectors.noncePrefix);
  const data = attachmentVectorPlaintext(vectors.plaintextLength);
  return [
    step('vector-attachment-encrypt', 'Stored attachment vector: same ciphertext hashes', () => {
      const { chunks, digests } = encryptAll(provider, key, prefix, data);
      checkEqual(
        JSON.stringify(chunks.map((c) => toBase64(c.sha256))),
        JSON.stringify(vectors.chunkSha256),
        'chunk hashes',
      );
      checkEqual(toBase64(digests.ciphertextSha256), vectors.ciphertextSha256, 'ciphertext hash');
      checkEqual(toBase64(digests.chunkHashListSha256), vectors.chunkHashListSha256, 'list hash');
    }),
    step('vector-attachment-decrypt', 'Stored attachment vector: the last chunk decrypts', () => {
      const last = provider.decryptAttachmentChunk(
        key,
        prefix,
        vectors.chunkSha256.length - 1,
        true,
        fromBase64(vectors.lastChunk),
      );
      checkEqual(toBase64(last), toBase64(data.subarray(ATTACHMENT_CHUNK_SIZE)), 'last chunk');
    }),
  ];
}
