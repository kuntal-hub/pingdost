// @pingdost/attachments: the platform-neutral attachment pipeline (Phase 14, ADR 0004):
// streaming encryption over `CryptoProvider`, manifests, MIME sniffing, the REQ §10.1 size
// rules and the resumable staging upload. Mobile (Phase 15) and web (Phase 18) bring file IO.
export * from './constants';
export { canSend, formatSize, isCompressible } from './limits';
export type { SendCheck } from './limits';
export {
  buildManifest,
  CAPTION_MAX,
  readManifest,
  safeFileName,
  THUMBNAIL_MAX_BYTES,
} from './manifest';
export type { CheckedManifest } from './manifest';
export { sniffMime, SNIFF_BYTES } from './mime';
export type { AttachmentCategory, SniffedType } from './mime';
export {
  AttachmentError,
  bytesEqual,
  decryptStream,
  encryptStream,
  newSecrets,
  rechunk,
} from './stream';
export type { AttachmentSecrets, DecryptInput, EncryptedAttachment } from './stream';
export { unpaddedBase64, uploadAttachment } from './upload';
export type { UploadInput } from './upload';
