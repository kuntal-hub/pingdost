/**
 * Attachments over the nearby mesh (Phase 24, ADR 0027). The file is not re-encrypted or
 * re-cut: each mesh chunk is one STREAM ciphertext chunk of the local copy (ADR 0004, 0018), so
 * the receiver's assembled file is byte for byte what a server download would have given, and
 * the same checks apply: every chunk's tag, the whole-ciphertext hash and the chunk-hash list.
 */
import type { CryptoProvider } from '@pingdost/crypto/core';

import { CIPHERTEXT_CHUNK_SIZE } from './constants';
import { AttachmentError, bytesEqual, verifyStream, type DecryptInput } from './stream';

/** One mesh chunk is one ciphertext chunk: 65,552 bytes, the last one shorter. */
export const MESH_CHUNK_BYTES = CIPHERTEXT_CHUNK_SIZE;

/**
 * Largest file sent over the mesh by default. REQ allows 100 MB, but over BLE that takes many
 * minutes per hop (ADR 0023 expects 50–150 KB/s; its measurement is still open). Configurable.
 */
export const DEFAULT_MESH_FILE_MAX_BYTES = 25 * 1_048_576;

/** Bytes per second assumed for estimates until ADR 0023's matrix is measured. */
export const MESH_RATE_LOW = 50_000;
export const MESH_RATE_HIGH = 150_000;

/** The byte range of chunk `index` in a ciphertext of `ciphertextSize` bytes: [start, end). */
export function meshChunkRange(index: number, ciphertextSize: number): [number, number] {
  const start = index * MESH_CHUNK_BYTES;
  if (index < 0 || start >= ciphertextSize) throw new RangeError('no such chunk');
  return [start, Math.min(start + MESH_CHUNK_BYTES, ciphertextSize)];
}

/** "about 2–6 min" for one Bluetooth hop (REQ: show a realistic time estimate). */
export function meshTimeEstimate(bytes: number): string {
  const fast = bytes / MESH_RATE_HIGH;
  const slow = bytes / MESH_RATE_LOW;
  const unit = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));
  if (slow < 60) return 'under a minute';
  const low = unit(fast);
  const high = unit(slow);
  return low === high ? `about ${high} min` : `about ${low}–${high} min`;
}

/** The manifest's `chunkHashListSha256`: SHA-256 over the per-chunk hashes in order. */
export function chunkHashListDigest(provider: CryptoProvider, hashes: Uint8Array[]): Uint8Array {
  const hasher = provider.createSha256();
  try {
    for (const hash of hashes) hasher.update(hash);
    return hasher.digest();
  } finally {
    hasher.dispose();
  }
}

/**
 * Checks a file assembled from mesh chunks completely before it counts as received (REQ
 * §19.3): the chunk-hash list against the manifest, then every chunk's tag and the whole
 * ciphertext hash (`verifyStream`). Throws `AttachmentError('integrity')` on any mismatch.
 */
export async function verifyMeshFile(
  provider: CryptoProvider,
  input: DecryptInput & { chunkHashListSha256: Uint8Array },
  chunkHashes: Uint8Array[],
  source: AsyncIterable<Uint8Array>,
): Promise<void> {
  if (chunkHashes.length !== input.chunkCount) {
    throw new AttachmentError('integrity', 'chunks are missing');
  }
  if (!bytesEqual(chunkHashListDigest(provider, chunkHashes), input.chunkHashListSha256)) {
    throw new AttachmentError('integrity', 'the chunk hash list does not match');
  }
  await verifyStream(provider, input, source);
}
