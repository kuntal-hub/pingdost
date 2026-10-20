// @pingdost/attachments: the platform-neutral attachment pipeline (Phase 14, ADR 0004, 0018):
// streaming encryption over `CryptoProvider`, manifests, MIME sniffing, the REQ §10.1 size
// rules and compression plans, the resumable staging upload and download. Mobile (Phase 15)
// and web (Phase 18) bring file IO and the encoders.
export * from './constants';
export {
  compressByDefault,
  IMAGE_PRESETS,
  planVideo,
  scaledSize,
  THUMBNAIL_PRESET,
  videoWorthCompressing,
} from './compression';
export type { ImagePreset, ImageQuality, VideoPlan, VideoSource } from './compression';
export { downloadCiphertext } from './download';
export type { DownloadInput } from './download';
export { canSend, formatSize, isCompressible } from './limits';
export type { SendCheck } from './limits';
export {
  buildManifest,
  CAPTION_MAX,
  readManifest,
  safeFileName,
  THUMBNAIL_MAX_BYTES,
  WAVEFORM_MAX,
} from './manifest';
export type { CheckedManifest, MediaDetails } from './manifest';
export { asRecordedAudio, sniffMime, SNIFF_BYTES } from './mime';
export type { AttachmentCategory, SniffedType } from './mime';
export {
  AttachmentError,
  bytesEqual,
  decryptStream,
  encryptStream,
  newSecrets,
  rechunk,
  verifyStream,
} from './stream';
export type { AttachmentSecrets, DecryptInput, EncryptedAttachment } from './stream';
export { throwIfAborted, unpaddedBase64, uploadAttachment } from './upload';
export type { UploadInput } from './upload';
