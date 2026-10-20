/** The attachment format (ADR 0004): XChaCha20-Poly1305 STREAM over 64 KiB chunks. */
export const SCHEME = 'xchacha20poly1305-stream-be32-64k/1';
/** Plaintext bytes per chunk; every chunk but the last is exactly this long. */
export const CHUNK_SIZE = 65_536;
/** The Poly1305 tag on every chunk. */
export const TAG_BYTES = 16;
export const CIPHERTEXT_CHUNK_SIZE = CHUNK_SIZE + TAG_BYTES;
export const KEY_BYTES = 32;
export const NONCE_PREFIX_BYTES = 19;
export const SHA256_BYTES = 32;

/**
 * Encryption chunks per upload part. The server picks per store: about 1 MiB on `fs`, so a
 * resumed upload repeats little; at least 5 MiB on S3, which refuses smaller multipart parts.
 */
export const PART_CHUNKS = 16;
export const S3_PART_CHUNKS = 80;
export const PART_BYTES = PART_CHUNKS * CIPHERTEXT_CHUNK_SIZE;

/** Chunks a plaintext of `size` bytes takes: always a last chunk, empty after a multiple. */
export function chunkCountFor(size: number): number {
  return Math.floor(size / CHUNK_SIZE) + 1;
}

export function ciphertextSizeFor(plaintextSize: number): number {
  return plaintextSize + chunkCountFor(plaintextSize) * TAG_BYTES;
}

/** Upload parts for a ciphertext of `size` bytes. */
export function partCountFor(ciphertextSize: number, partSize: number = PART_BYTES): number {
  return Math.max(1, Math.ceil(ciphertextSize / partSize));
}
