/**
 * `AttachmentManifest` (content.proto, ADR 0004): how to fetch and decrypt one attachment. It
 * travels inside E2EE `Content`, so the key never reaches the server. Receivers check every
 * field before they trust it (`readManifest`).
 */
import { DEFAULT_LIMITS } from '@pingdost/config/public';
import {
  AttachmentManifestSchema,
  bytesToUuid,
  create,
  uuidToBytes,
  type AttachmentManifest,
} from '@pingdost/protocol';

import {
  CHUNK_SIZE,
  chunkCountFor,
  ciphertextSizeFor,
  KEY_BYTES,
  NONCE_PREFIX_BYTES,
  SCHEME,
  SHA256_BYTES,
} from './constants';
import { AttachmentError, type EncryptedAttachment } from './stream';

/** A thumbnail is a small preview; anything bigger is not one. */
export const THUMBNAIL_MAX_BYTES = 262_144;
const MAX_NAME = 255;

export interface CheckedManifest {
  attachmentId: string;
  key: Uint8Array;
  noncePrefix: Uint8Array;
  plaintextSize: number;
  chunkCount: number;
  ciphertextSize: number;
  mimeType: string;
  fileName: string | undefined;
  ciphertextSha256: Uint8Array;
  chunkHashListSha256: Uint8Array;
  thumbnail: CheckedManifest | undefined;
  /** Text shown with the attachment (empty for none). */
  caption: string;
}

/** Longest caption: like a text message. */
export const CAPTION_MAX = 4_000;

/** A file name to show and save under: no folders, no control characters. */
export function safeFileName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const controls = /[\u0000-\u001f\u007f]/g;
  const clean = base.replace(controls, '').trim().slice(0, MAX_NAME);
  return clean === '' || clean === '.' || clean === '..' ? undefined : clean;
}

export function buildManifest(fields: {
  attachmentId: string;
  encrypted: EncryptedAttachment;
  /** From `sniffMime`, never from the file name. */
  mimeType: string;
  fileName?: string;
  thumbnail?: AttachmentManifest;
  caption?: string;
}): AttachmentManifest {
  const { encrypted } = fields;
  const fileName = safeFileName(fields.fileName);
  return create(AttachmentManifestSchema, {
    attachmentId: uuidToBytes(fields.attachmentId),
    scheme: SCHEME,
    key: encrypted.key,
    noncePrefix: encrypted.noncePrefix,
    plaintextSize: BigInt(encrypted.plaintextSize),
    chunkSize: CHUNK_SIZE,
    chunkCount: encrypted.chunkCount,
    mimeType: fields.mimeType,
    ...(fileName ? { fileName } : {}),
    ciphertextSha256: encrypted.ciphertextSha256,
    chunkHashListSha256: encrypted.chunkHashListSha256,
    ...(fields.thumbnail ? { thumbnail: fields.thumbnail } : {}),
    ...(fields.caption ? { caption: fields.caption.slice(0, CAPTION_MAX) } : {}),
  });
}

/** Checks a received manifest; throws `AttachmentError('invalid')` on anything off. */
export function readManifest(
  manifest: AttachmentManifest,
  maxBytes: number = DEFAULT_LIMITS.attachmentMaxBytes,
  nested = false,
): CheckedManifest {
  const fail = (what: string): never => {
    throw new AttachmentError('invalid', `attachment manifest: ${what}`);
  };
  let attachmentId = '';
  try {
    attachmentId = bytesToUuid(manifest.attachmentId);
  } catch {
    fail('attachment ID');
  }
  if (manifest.scheme !== SCHEME) fail('unknown scheme');
  if (manifest.key.length !== KEY_BYTES) fail('key');
  if (manifest.noncePrefix.length !== NONCE_PREFIX_BYTES) fail('nonce prefix');
  if (manifest.chunkSize !== CHUNK_SIZE) fail('chunk size');
  const plaintextSize = Number(manifest.plaintextSize);
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize > maxBytes) fail('size');
  if (manifest.chunkCount !== chunkCountFor(plaintextSize)) fail('chunk count');
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(manifest.mimeType) || manifest.mimeType.length > 127) {
    fail('MIME type');
  }
  if (manifest.ciphertextSha256.length !== SHA256_BYTES) fail('ciphertext hash');
  if (manifest.chunkHashListSha256.length !== SHA256_BYTES) fail('chunk hash list hash');
  if (manifest.thumbnail && nested) fail('a thumbnail has no thumbnail');
  return {
    attachmentId,
    key: manifest.key,
    noncePrefix: manifest.noncePrefix,
    plaintextSize,
    chunkCount: manifest.chunkCount,
    ciphertextSize: ciphertextSizeFor(plaintextSize),
    mimeType: manifest.mimeType,
    fileName: safeFileName(manifest.fileName),
    ciphertextSha256: manifest.ciphertextSha256,
    chunkHashListSha256: manifest.chunkHashListSha256,
    thumbnail: manifest.thumbnail
      ? readManifest(manifest.thumbnail, THUMBNAIL_MAX_BYTES, true)
      : undefined,
    caption: nested ? '' : manifest.caption.slice(0, CAPTION_MAX),
  };
}
