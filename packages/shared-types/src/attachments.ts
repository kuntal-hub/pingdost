/** Attachment staging DTOs: `/v1/attachments*` (Phase 14). Ciphertext only (ADR 0004). */
import { z } from 'zod';

import { EpochMsSchema, IdSchema, UnpaddedBase64Schema } from './common';

export const AttachmentStatusSchema = z.enum(['uploading', 'ready', 'deleting']);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;

// POST /v1/attachments
export const CreateAttachmentRequestSchema = z.object({
  /** Client-generated UUIDv7; also `AttachmentManifest.attachment_id`. */
  attachmentId: IdSchema,
  ciphertextBytes: z.int().positive(),
  /** SHA-256 over the whole ciphertext (unpadded base64). */
  ciphertextSha256: UnpaddedBase64Schema,
  recipientDeviceIds: z.array(IdSchema).min(1),
});
export type CreateAttachmentRequest = z.infer<typeof CreateAttachmentRequestSchema>;

export const CreateAttachmentResponseSchema = z.object({
  attachmentId: IdSchema,
  uploadId: z.string().min(1),
  /** Upload chunk size in bytes (may group several 64 KiB encryption chunks). */
  chunkSize: z.int().positive(),
  uploadUrls: z.array(z.object({ index: z.int().nonnegative(), url: z.url() })),
  expiresAt: EpochMsSchema,
});
export type CreateAttachmentResponse = z.infer<typeof CreateAttachmentResponseSchema>;

// GET /v1/attachments/:attachmentId/status, and POST …/complete
export const AttachmentStatusResponseSchema = z.object({
  attachmentId: IdSchema,
  status: AttachmentStatusSchema,
  /** Upload chunk indexes received so far, for resume. */
  receivedChunks: z.array(z.int().nonnegative()),
});
export type AttachmentStatusResponse = z.infer<typeof AttachmentStatusResponseSchema>;

// POST /v1/attachments/:attachmentId/download-url (recipient devices only)
export const DownloadUrlResponseSchema = z.object({ url: z.url(), expiresAt: EpochMsSchema });
export type DownloadUrlResponse = z.infer<typeof DownloadUrlResponseSchema>;

// POST /v1/attachments/:attachmentId/ack → 204
