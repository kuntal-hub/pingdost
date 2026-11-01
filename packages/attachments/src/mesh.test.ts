// Attachments over the mesh (ADR 0027): chunk ranges, the estimate, and the full check of an
// assembled file.
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';

import {
  AttachmentError,
  buildManifest,
  chunkHashListDigest,
  CIPHERTEXT_CHUNK_SIZE,
  encryptStream,
  MESH_CHUNK_BYTES,
  meshChunkRange,
  meshTimeEstimate,
  readManifest,
  verifyMeshFile,
} from './index';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

/** One piece, as an async stream (what `encryptStream` reads). */
async function* once(bytes: Uint8Array) {
  await Promise.resolve();
  yield bytes;
}

async function encrypt(size: number) {
  const plaintext = new Uint8Array(randomBytes(size));
  const chunks: Uint8Array[] = [];
  const stream = encryptStream(provider, once(plaintext));
  let result = await stream.next();
  while (!result.done) {
    chunks.push(result.value);
    result = await stream.next();
  }
  return { chunks, encrypted: result.value };
}

async function* from(chunks: Uint8Array[]) {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}

describe('attachments over the mesh', () => {
  it('cuts the ciphertext into exactly its STREAM chunks', async () => {
    const { chunks, encrypted } = await encrypt(3 * 65_536 + 10);
    expect(chunks).toHaveLength(encrypted.chunkCount);
    expect(MESH_CHUNK_BYTES).toBe(CIPHERTEXT_CHUNK_SIZE);
    const whole = new Uint8Array(encrypted.ciphertextSize);
    let offset = 0;
    for (const chunk of chunks) {
      whole.set(chunk, offset);
      offset += chunk.length;
    }
    for (let i = 0; i < chunks.length; i++) {
      const [start, end] = meshChunkRange(i, encrypted.ciphertextSize);
      expect(whole.subarray(start, end)).toEqual(chunks[i]);
    }
    expect(() => meshChunkRange(chunks.length, encrypted.ciphertextSize)).toThrow(RangeError);
  });

  it('derives the manifest chunk-hash list digest from the per-chunk hashes', async () => {
    const { encrypted } = await encrypt(100_000);
    expect(chunkHashListDigest(provider, encrypted.chunkHashes)).toEqual(
      encrypted.chunkHashListSha256,
    );
  });

  it('accepts only the complete, intact file', async () => {
    const { chunks, encrypted } = await encrypt(200_000);
    const manifest = readManifest(
      buildManifest({
        attachmentId: '01890a5d-ac96-774b-bcce-b302099a8057',
        encrypted,
        mimeType: 'application/pdf',
        mesh: true,
      }),
    );
    expect(manifest.mesh).toBe(true);
    const hashes = encrypted.chunkHashes;
    await verifyMeshFile(provider, manifest, hashes, from(chunks));

    await expect(verifyMeshFile(provider, manifest, hashes.slice(1), from(chunks))).rejects.toThrow(
      AttachmentError,
    );
    const swapped = [chunks[1]!, chunks[0]!, ...chunks.slice(2)];
    await expect(verifyMeshFile(provider, manifest, hashes, from(swapped))).rejects.toThrow(
      AttachmentError,
    );
    const flipped = chunks.map((c) => c.slice());
    flipped[1]![10] = flipped[1]![10]! ^ 1;
    await expect(verifyMeshFile(provider, manifest, hashes, from(flipped))).rejects.toThrow(
      AttachmentError,
    );
  });

  it('estimates BLE time realistically', () => {
    expect(meshTimeEstimate(1_000_000)).toBe('under a minute');
    expect(meshTimeEstimate(10 * 1_048_576)).toBe('about 2–4 min');
    expect(meshTimeEstimate(100 * 1_048_576)).toMatch(/^about \d+–\d+ min$/);
  });
});
