/**
 * Streaming attachment encryption and decryption (ADR 0004) over async iterables of bytes, so
 * mobile (file reads) and web (`Blob.slice`) feed it chunk by chunk and never hold a whole
 * file. The crypto itself is the Rust STREAM implementation behind `CryptoProvider`.
 */
import type { CryptoProvider } from '@pingdost/crypto/core';

import {
  CHUNK_SIZE,
  CIPHERTEXT_CHUNK_SIZE,
  KEY_BYTES,
  NONCE_PREFIX_BYTES,
  SHA256_BYTES,
} from './constants';

export interface AttachmentSecrets {
  /** 32 random bytes; never reused. */
  key: Uint8Array;
  /** 19 random bytes; never reused. */
  noncePrefix: Uint8Array;
}

export interface EncryptedAttachment extends AttachmentSecrets {
  plaintextSize: number;
  ciphertextSize: number;
  chunkCount: number;
  ciphertextSha256: Uint8Array;
  chunkHashListSha256: Uint8Array;
  /** The per-chunk SHA-256s (the list travels with the ciphertext, e.g. over the mesh). */
  chunkHashes: Uint8Array[];
}

export class AttachmentError extends Error {
  constructor(
    readonly code: 'invalid' | 'integrity' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** Fresh secrets from the platform CSPRNG (Web Crypto; expo-crypto on React Native). */
export function newSecrets(): AttachmentSecrets {
  return {
    key: crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
    noncePrefix: crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES)),
  };
}

/** Re-cuts a byte stream into pieces of exactly `size` bytes; the final piece may be shorter. */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(size);
  let filled = 0;
  for await (const piece of source) {
    let offset = 0;
    while (offset < piece.length) {
      const take = Math.min(size - filled, piece.length - offset);
      buffer.set(piece.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.subarray(0, filled);
}

/**
 * Encrypts `source` chunk by chunk, yielding each ciphertext chunk in order; the generator's
 * return value has the secrets and hashes for the manifest. The last chunk is known only when
 * the source ends, so one chunk is held back; an empty file is one empty final chunk.
 */
export async function* encryptStream(
  provider: CryptoProvider,
  source: AsyncIterable<Uint8Array>,
  secrets: AttachmentSecrets = newSecrets(),
): AsyncGenerator<Uint8Array, EncryptedAttachment> {
  const encryptor = provider.createAttachmentEncryptor(secrets.key, secrets.noncePrefix);
  const chunkHashes: Uint8Array[] = [];
  try {
    let pending: Uint8Array | undefined;
    for await (const chunk of rechunk(source, CHUNK_SIZE)) {
      if (pending) {
        const out = encryptor.encryptChunk(pending, false);
        chunkHashes.push(out.sha256);
        yield out.ciphertext;
      }
      pending = chunk;
    }
    // A full last chunk is followed by an empty final one, so its length marks no end.
    if (pending && pending.length === CHUNK_SIZE) {
      const out = encryptor.encryptChunk(pending, false);
      chunkHashes.push(out.sha256);
      yield out.ciphertext;
      pending = undefined;
    }
    const last = encryptor.encryptChunk(pending ?? new Uint8Array(0), true);
    chunkHashes.push(last.sha256);
    yield last.ciphertext;
    const digests = encryptor.finish();
    return { ...secrets, ...digests, chunkHashes };
  } finally {
    encryptor.dispose();
  }
}

export interface DecryptInput extends AttachmentSecrets {
  chunkCount: number;
  ciphertextSha256: Uint8Array;
}

/**
 * Decrypts a ciphertext stream in order, yielding plaintext chunks. Each chunk is
 * authenticated as it comes; the whole-ciphertext hash is checked at the end, and a mismatch
 * throws (`integrity`): discard what was written.
 */
export async function* decryptStream(
  provider: CryptoProvider,
  input: DecryptInput,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (input.ciphertextSha256.length !== SHA256_BYTES) {
    throw new AttachmentError('invalid', 'bad ciphertext hash');
  }
  const hasher = provider.createSha256();
  try {
    let index = 0;
    for await (const chunk of rechunk(source, CIPHERTEXT_CHUNK_SIZE)) {
      if (index >= input.chunkCount) throw new AttachmentError('integrity', 'too many chunks');
      hasher.update(chunk);
      try {
        yield provider.decryptAttachmentChunk(
          input.key,
          input.noncePrefix,
          index,
          index === input.chunkCount - 1,
          chunk,
        );
      } catch (error) {
        if (error instanceof AttachmentError) throw error;
        throw new AttachmentError('integrity', `chunk ${index} failed authentication`);
      }
      index++;
    }
    if (index !== input.chunkCount) throw new AttachmentError('integrity', 'the file is cut short');
    if (!bytesEqual(hasher.digest(), input.ciphertextSha256)) {
      throw new AttachmentError('integrity', 'the ciphertext hash does not match');
    }
  } finally {
    hasher.dispose();
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
