/**
 * Attachment staging DTOs: `/v1/attachments*` (Phase 14). Ciphertext only (ADR 0004): the
 * server learns sizes, hashes and recipient devices, never keys, names or types.
 */
import { z } from 'zod';

import { EpochMsSchema, IdSchema, UnpaddedBase64Schema } from './common';

export const AttachmentStatusSchema = z.enum(['uploading', 'ready', 'deleting']);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;

/** Recipient devices per attachment (a group of 64 with a few devices each). */
export const MAX_ATTACHMENT_RECIPIENTS = 512;

/** A signed URL for one upload part (`PUT` the part's bytes to it). */
export const UploadUrlSchema = z.object({ index: z.int().nonnegative(), url: z.url() });
export type UploadUrl = z.infer<typeof UploadUrlSchema>;

// POST /v1/attachments
export const CreateAttachmentRequestSchema = z.object({
  /** Client-generated UUIDv7; also `AttachmentManifest.attachment_id`. */
  attachmentId: IdSchema,
  ciphertextBytes: z.int().positive(),
  /** SHA-256 over the whole ciphertext (unpadded base64). */
  ciphertextSha256: UnpaddedBase64Schema,
  /** The devices that may download it: the recipients' and the sender's other devices. */
  recipientDeviceIds: z.array(IdSchema).min(1).max(MAX_ATTACHMENT_RECIPIENTS),
  /** The linked message's expiry: the staged object is deleted no later (REQ §10.2). */
  expiresAt: EpochMsSchema.optional(),
});
export type CreateAttachmentRequest = z.infer<typeof CreateAttachmentRequestSchema>;

export const CreateAttachmentResponseSchema = z.object({
  attachmentId: IdSchema,
  /**
   * Bytes per upload part (whole encryption chunks: about 1 MiB on `fs`, 5 MiB on `s3`); the
   * last part may be shorter.
   */
  partSize: z.int().positive(),
  partCount: z.int().positive(),
  uploadUrls: z.array(UploadUrlSchema),
  /** The upload URLs stop working then; `GET …/status` hands out fresh ones. */
  urlsExpireAt: EpochMsSchema,
  /** The staged object is deleted then at the latest. */
  expiresAt: EpochMsSchema,
});
export type CreateAttachmentResponse = z.infer<typeof CreateAttachmentResponseSchema>;

// GET /v1/attachments/:attachmentId/status (the uploader), and POST …/complete
export const AttachmentStatusResponseSchema = z.object({
  attachmentId: IdSchema,
  status: AttachmentStatusSchema,
  partSize: z.int().positive(),
  partCount: z.int().positive(),
  /** Upload parts received so far, for resume. */
  receivedParts: z.array(z.int().nonnegative()),
  /** Fresh URLs for the parts still missing. */
  uploadUrls: z.array(UploadUrlSchema),
  urlsExpireAt: EpochMsSchema,
  expiresAt: EpochMsSchema,
});
export type AttachmentStatusResponse = z.infer<typeof AttachmentStatusResponseSchema>;

// POST /v1/attachments/:attachmentId/download-url (recipient devices only)
export const DownloadUrlResponseSchema = z.object({
  url: z.url(),
  /** The URL stops working then. */
  expiresAt: EpochMsSchema,
  ciphertextBytes: z.int().positive(),
});
export type DownloadUrlResponse = z.infer<typeof DownloadUrlResponseSchema>;

// POST /v1/attachments/:attachmentId/ack (a recipient device has it) → 204
