// Maps API failures to short, user-facing messages, and to the form field they belong to.
// Messages never echo server details or user input (ARCHITECTURE A10).
import { ApiError } from '@pingdost/api-client';
import type { ErrorCode } from '@pingdost/shared-types';

export interface UserFacingError {
  message: string;
  /** The form field the error belongs to, if any. */
  field?: string;
  /** No response at all: offline, unreachable server or timeout. */
  offline?: boolean;
  /** Seconds before the same request may succeed. */
  retryAfterSeconds?: number;
}

function wait(seconds: number | undefined): string {
  if (seconds === undefined) return 'a moment';
  if (seconds < 90) return `${seconds} s`;
  return `${Math.ceil(seconds / 60)} min`;
}

type Described = Omit<UserFacingError, 'retryAfterSeconds'>;

function describeCode(code: ErrorCode, retryAfter: number | undefined): Described | undefined {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return { message: 'Wrong username, email or password.' };
    case 'ACCOUNT_LOCKED':
      return { message: `Too many failed attempts. Try again in ${wait(retryAfter)}.` };
    case 'ACCOUNT_DISABLED':
      return { message: 'This account is disabled.' };
    case 'EMAIL_TAKEN':
      return { message: 'This email already has an account. Log in instead.', field: 'email' };
    case 'USERNAME_TAKEN':
      return { message: 'This username is taken.', field: 'username' };
    case 'USERNAME_RESERVED':
      return { message: 'This username is reserved.', field: 'username' };
    case 'EMAIL_NOT_VERIFIED':
      return { message: 'Verify your email address first.' };
    case 'OTP_INVALID':
      return { message: 'That code is not right.', field: 'otp' };
    case 'OTP_EXPIRED':
      return { message: 'This code has expired. Request a new one.', field: 'otp' };
    case 'OTP_ATTEMPTS_EXCEEDED':
      return { message: 'Too many wrong codes. Request a new one.', field: 'otp' };
    case 'OTP_RESEND_COOLDOWN':
      return { message: `Wait ${wait(retryAfter)} before requesting another code.` };
    case 'RATE_LIMITED':
      return { message: `Too many attempts. Try again in ${wait(retryAfter)}.` };
    case 'GOOGLE_TOKEN_INVALID':
      return { message: 'Google sign-in failed. Try again.' };
    case 'GOOGLE_EMAIL_UNVERIFIED':
      return { message: 'Your Google account has no verified email address.' };
    case 'PRIMARY_EXISTS':
      return { message: 'This account is active on another phone.' };
    case 'TOKEN_EXPIRED':
    case 'TOKEN_INVALID':
    case 'TOKEN_REUSED':
    case 'UNAUTHENTICATED':
    case 'DEVICE_REVOKED':
      return { message: 'You were signed out. Log in again.' };
    case 'UNAVAILABLE':
    case 'MAILBOX_UNAVAILABLE':
      return { message: 'PingDost is unavailable right now. Try again soon.' };
    case 'VALIDATION_FAILED':
      return { message: 'Check the highlighted fields.' };
    default:
      return undefined;
  }
}

/**
 * A message for any thrown value. `overrides` replaces the text for specific codes, e.g. a
 * screen-specific `UNAVAILABLE` message.
 */
export function describeError(
  error: unknown,
  overrides: Partial<Record<ErrorCode, string>> = {},
): UserFacingError {
  if (!(error instanceof ApiError)) return { message: 'Something went wrong. Try again.' };
  if (error.kind === 'network' || error.kind === 'timeout') {
    return {
      message: "Can't reach PingDost. Check your connection and try again.",
      offline: true,
    };
  }
  if (error.kind === 'aborted') return { message: 'Cancelled.' };

  const retryAfterSeconds = error.problem?.retryAfterSeconds;
  const described = describeCode(error.code, retryAfterSeconds) ?? {
    message: 'Something went wrong. Try again.',
  };
  const override = overrides[error.code];
  const field =
    described.field ??
    (error.code === 'VALIDATION_FAILED' ? error.problem?.errors?.[0]?.path : undefined);
  return {
    message: override ?? described.message,
    ...(field === undefined ? {} : { field }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/** The error code of an `ApiError`, if it is one. */
export function errorCode(error: unknown): ErrorCode | undefined {
  return error instanceof ApiError && error.kind === 'http' ? error.code : undefined;
}
