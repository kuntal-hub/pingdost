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
/** Samples in a voice note's waveform. */
export const WAVEFORM_MAX = 64;
/** Larger dimensions are not real media. */
const MAX_DIMENSION = 65_535;

/** Measured on the sender's device (ADR 0018); 0 or empty means unknown. */
export interface MediaDetails {
  width: number;
  height: number;
  durationMs: number;
  /** Voice notes: loudness samples, 0–255. */
  waveform: Uint8Array;
}

export interface CheckedManifest extends MediaDetails {
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
  /** The file comes over the nearby mesh, not the server (ADR 0027). */
  mesh: boolean;
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
  media?: Partial<MediaDetails>;
  /** Sent over the nearby mesh in chunks, with no staged upload (ADR 0027). */
  mesh?: boolean;
}): AttachmentManifest {
  const { encrypted, media } = fields;
  const fileName = safeFileName(fields.fileName);
  const dimension = (value: number | undefined) =>
    value && value > 0 && value <= MAX_DIMENSION ? Math.round(value) : 0;
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
    width: dimension(media?.width),
    height: dimension(media?.height),
    durationMs:
      media?.durationMs && media.durationMs > 0
        ? Math.min(Math.round(media.durationMs), 0xffff_ffff)
        : 0,
    waveform: media?.waveform?.subarray(0, WAVEFORM_MAX) ?? new Uint8Array(0),
    mesh: fields.mesh ?? false,
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
  if (manifest.width > MAX_DIMENSION || manifest.height > MAX_DIMENSION) fail('dimensions');
  if (manifest.waveform.length > WAVEFORM_MAX) fail('waveform');
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
    width: manifest.width,
    height: manifest.height,
    durationMs: manifest.durationMs,
    waveform: manifest.waveform,
    mesh: manifest.mesh,
  };
}
