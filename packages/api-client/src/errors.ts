import type { ErrorCode, Problem } from '@pingdost/shared-types';

/**
 * - `http`: the server answered with an error status (`problem` when it sent problem+json);
 * - `network`: no response (offline, DNS, connection reset);
 * - `timeout`: no response within the timeout;
 * - `aborted`: the caller's signal aborted the request;
 * - `invalid_response`: a 2xx body that does not match the expected schema.
 */
export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'aborted' | 'invalid_response';

/**
 * Every failed request rejects with an ApiError. Messages hold the method, path and status
 * only: never tokens, bodies or query strings (ARCHITECTURE A10).
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status; 0 when there was no response. */
  readonly status: number;
  readonly code: ErrorCode;
  readonly problem: Problem | undefined;

  constructor(
    kind: ApiErrorKind,
    message: string,
    details: { status?: number; code: ErrorCode; problem?: Problem },
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = details.status ?? 0;
    this.code = details.code;
    this.problem = details.problem;
  }
}
