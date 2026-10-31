/**
 * The `.pdbk` file (ADR 0022): a cleartext header, then the body encrypted with the
 * attachment STREAM (XChaCha20-Poly1305, 64 KiB chunks; ADR 0004) under a key derived with
 * Argon2id from the recovery phrase.
 *
 * Header, big-endian, 69 bytes in version 1:
 *
 * | offset | size | field                                       |
 * |-------:|-----:|---------------------------------------------|
 * |      0 |    8 | magic `89 50 44 42 4B 0D 0A 1A` ("\x89PDBK\r\n\x1a") |
 * |      8 |    2 | format version (1)                          |
 * |     10 |    1 | KDF (1 = Argon2id v0x13)                    |
 * |     11 |    4 | memory, KiB                                 |
 * |     15 |    1 | passes                                      |
 * |     16 |    1 | lanes                                       |
 * |     17 |    1 | salt length (32)                            |
 * |     18 |   32 | salt                                        |
 * |     50 |   19 | STREAM nonce prefix                         |
 *
 * The header holds no account data. Every field but the magic, version and KDF ID feeds the
 * key or the nonce, and the body's first record repeats the header's SHA-256, so a changed
 * header fails the restore.
 */
import type { BackupKdfParams } from '@pingdost/crypto/core';

import { BackupError } from './errors';

export const BACKUP_MAGIC = Uint8Array.of(0x89, 0x50, 0x44, 0x42, 0x4b, 0x0d, 0x0a, 0x1a);
export const BACKUP_FORMAT_VERSION = 1;
export const KDF_ARGON2ID = 1;
export const SALT_LENGTH = 32;
export const NONCE_PREFIX_LENGTH = 19;
export const HEADER_LENGTH = 18 + SALT_LENGTH + NONCE_PREFIX_LENGTH;
/** Plaintext per STREAM chunk, and the ciphertext of a full chunk (16-byte tag). */
export const CHUNK_SIZE = 65_536;
export const CIPHER_CHUNK_SIZE = CHUNK_SIZE + 16;
/** The file extension and the MIME type the share sheet and pickers use. */
export const BACKUP_EXTENSION = '.pdbk';
export const BACKUP_MIME_TYPE = 'application/octet-stream';

/**
 * RFC 9106's second recommendation (64 MiB, 3 passes) with one lane: about 0.5 s in WASM on a
 * desktop and a few seconds on a low-end phone. The phrase already carries 256 bits, so this
 * is a margin, not the main defence.
 */
export const DEFAULT_KDF_PARAMS: BackupKdfParams = {
  memoryKib: 65_536,
  iterations: 3,
  parallelism: 1,
};

export interface BackupHeader {
  version: number;
  kdf: BackupKdfParams;
  salt: Uint8Array;
  noncePrefix: Uint8Array;
}

export function encodeHeader(header: BackupHeader): Uint8Array {
  if (header.salt.length !== SALT_LENGTH || header.noncePrefix.length !== NONCE_PREFIX_LENGTH) {
    throw new Error('backup header: wrong salt or nonce length');
  }
  const out = new Uint8Array(HEADER_LENGTH);
  const view = new DataView(out.buffer);
  out.set(BACKUP_MAGIC, 0);
  view.setUint16(8, header.version);
  out[10] = KDF_ARGON2ID;
  view.setUint32(11, header.kdf.memoryKib);
  out[15] = header.kdf.iterations;
  out[16] = header.kdf.parallelism;
  out[17] = SALT_LENGTH;
  out.set(header.salt, 18);
  out.set(header.noncePrefix, 18 + SALT_LENGTH);
  return out;
}

/** The header at the start of `bytes` (at least `HEADER_LENGTH` of them). */
export function decodeHeader(bytes: Uint8Array): BackupHeader {
  if (bytes.length < 10 || !BACKUP_MAGIC.every((byte, i) => bytes[i] === byte)) {
    throw new BackupError('not_a_backup');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(8);
  if (version !== BACKUP_FORMAT_VERSION) throw new BackupError('unsupported_version');
  if (bytes.length < HEADER_LENGTH) throw new BackupError('truncated');
  if (bytes[10] !== KDF_ARGON2ID || bytes[17] !== SALT_LENGTH) {
    throw new BackupError('unsupported_version');
  }
  return {
    version,
    kdf: { memoryKib: view.getUint32(11), iterations: bytes[15]!, parallelism: bytes[16]! },
    salt: bytes.slice(18, 18 + SALT_LENGTH),
    noncePrefix: bytes.slice(18 + SALT_LENGTH, HEADER_LENGTH),
  };
}

/** `pingdost-backup-2026-10-31.pdbk`, in local time. */
export function backupFileName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `pingdost-backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}${BACKUP_EXTENSION}`;
}
