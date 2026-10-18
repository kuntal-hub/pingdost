import { z } from 'zod';

/**
 * Error codes shared by REST problem+json and the WebSocket `ServerError` frame
 * (ARCHITECTURE A2, ADR 0006). Add codes freely; never rename or reuse one.
 */
export const ErrorCodeSchema = z.enum([
  // Generic
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL',
  'UNAVAILABLE',
  // Auth and account (Phases 5–6)
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'EMAIL_TAKEN',
  'USERNAME_TAKEN',
  'USERNAME_RESERVED',
  'EMAIL_NOT_VERIFIED',
  'USERNAME_REQUIRED',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_RESEND_COOLDOWN',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'TOKEN_REUSED',
  'GOOGLE_TOKEN_INVALID',
  // Devices and keys (Phase 6)
  'PRIMARY_EXISTS',
  'DEVICE_NOT_FOUND',
  'DEVICE_REVOKED',
  'CHALLENGE_EXPIRED',
  'INVALID_SIGNATURE',
  // Delivery and the wire protocol (Phases 8–9)
  'PROTOCOL_VERSION_UNSUPPORTED',
  'MALFORMED_FRAME',
  'ENVELOPE_TOO_LARGE',
  'ENVELOPE_EXPIRED',
  'RECIPIENT_UNKNOWN',
  'RECIPIENT_OFFLINE',
  'MAILBOX_UNAVAILABLE',
  /** A newer socket for the same device took over. */
  'CONNECTION_REPLACED',
  // Groups (Phase 13)
  'GROUP_FULL',
  'NOT_A_MEMBER',
  // Attachments (Phase 14)
  'ATTACHMENT_TOO_LARGE',
  'ATTACHMENT_QUOTA_EXCEEDED',
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_EXPIRED',
  // Web pairing (Phase 16)
  'PAIRING_NOT_FOUND',
  'PAIRING_EXPIRED',
  'PAIRING_ALREADY_USED',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
/** `ErrorCode.RATE_LIMITED` etc. */
export const ErrorCode = ErrorCodeSchema.enum;

/** The HTTP status each code is sent with. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  EMAIL_TAKEN: 409,
  USERNAME_TAKEN: 409,
  USERNAME_RESERVED: 409,
  EMAIL_NOT_VERIFIED: 403,
  USERNAME_REQUIRED: 403,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  OTP_RESEND_COOLDOWN: 429,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  TOKEN_REUSED: 401,
  GOOGLE_TOKEN_INVALID: 401,
  PRIMARY_EXISTS: 409,
  DEVICE_NOT_FOUND: 404,
  DEVICE_REVOKED: 401,
  CHALLENGE_EXPIRED: 400,
  INVALID_SIGNATURE: 400,
  PROTOCOL_VERSION_UNSUPPORTED: 400,
  MALFORMED_FRAME: 400,
  ENVELOPE_TOO_LARGE: 413,
  ENVELOPE_EXPIRED: 400,
  RECIPIENT_UNKNOWN: 404,
  RECIPIENT_OFFLINE: 409,
  MAILBOX_UNAVAILABLE: 503,
  CONNECTION_REPLACED: 409,
  GROUP_FULL: 409,
  NOT_A_MEMBER: 403,
  ATTACHMENT_TOO_LARGE: 413,
  ATTACHMENT_QUOTA_EXCEEDED: 413,
  ATTACHMENT_NOT_FOUND: 404,
  ATTACHMENT_EXPIRED: 410,
  PAIRING_NOT_FOUND: 404,
  PAIRING_EXPIRED: 410,
  PAIRING_ALREADY_USED: 409,
};

/** Codes for which the same request may succeed later (after any `retryAfterSeconds`). */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'UNAVAILABLE',
  'MAILBOX_UNAVAILABLE',
  'OTP_RESEND_COOLDOWN',
]);

/** A generic code for an HTTP status, when a response carries no usable code. */
export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
    case 410:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    case 502:
    case 503:
    case 504:
      return 'UNAVAILABLE';
    default:
      return 'INTERNAL';
  }
}
