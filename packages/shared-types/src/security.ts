/**
 * Blocks and abuse reports: `/v1/blocks*`, `/v1/reports` (Phase 11, ADR 0014). Blocked
 * users are not told; the server drops what they send to the blocker.
 */
import { z } from 'zod';

import { EpochMsSchema, IdSchema } from './common';

/** Blocks one account can hold. */
export const MAX_BLOCKS = 1_000;

// GET /v1/blocks
export const BlockListResponseSchema = z.object({ userIds: z.array(IdSchema) });
export type BlockListResponse = z.infer<typeof BlockListResponseSchema>;

export const ReportReasonSchema = z.enum([
  'spam',
  'harassment',
  'impersonation',
  'illegal_content',
  'other',
]);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

/** Messages a reporter may attach to one report. */
export const MAX_REPORT_MESSAGES = 20;
export const MAX_REPORT_TEXT = 4_000;

/**
 * A message the reporter chose to disclose, decrypted on their device: plaintext they hand
 * over on purpose. Nothing is attached unless they pick it.
 */
export const ReportedMessageSchema = z.object({
  messageId: IdSchema,
  senderUserId: IdSchema,
  sentAt: EpochMsSchema,
  text: z.string().max(MAX_REPORT_TEXT),
});
export type ReportedMessage = z.infer<typeof ReportedMessageSchema>;

// POST /v1/reports
export const CreateReportRequestSchema = z.object({
  reportedUserId: IdSchema,
  reason: ReportReasonSchema,
  details: z.string().trim().max(1_000).optional(),
  messages: z.array(ReportedMessageSchema).max(MAX_REPORT_MESSAGES).default([]),
});
export type CreateReportRequest = z.input<typeof CreateReportRequestSchema>;
/** The request as the server sees it after validation (`messages` defaulted). */
export type ParsedReportRequest = z.output<typeof CreateReportRequestSchema>;

export const CreateReportResponseSchema = z.object({ reportId: IdSchema });
export type CreateReportResponse = z.infer<typeof CreateReportResponseSchema>;
