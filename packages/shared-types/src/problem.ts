import { z } from 'zod';

import { ErrorCodeSchema, type ErrorCode } from './errors';

/** RFC 9457 media type for error responses (ARCHITECTURE A2). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * An RFC 9457 problem with PingDost's `code`. `detail` and `errors` never contain secrets
 * or user content (ARCHITECTURE A10).
 */
export const ProblemSchema = z.object({
  /** A URI naming the problem type: `problemType(code)`. */
  type: z.string(),
  title: z.string(),
  status: z.int().min(400).max(599),
  code: ErrorCodeSchema,
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Seconds to wait before retrying (mirrors `Retry-After`). */
  retryAfterSeconds: z.int().positive().optional(),
  /** Per-field problems for `VALIDATION_FAILED`. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type Problem = z.infer<typeof ProblemSchema>;

/** The `type` URI for a code, e.g. `https://pingdost.com/problems/rate-limited`. */
export function problemType(code: ErrorCode): string {
  return `https://pingdost.com/problems/${code.toLowerCase().replaceAll('_', '-')}`;
}
