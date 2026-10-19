/**
 * problem+json errors (ARCHITECTURE A2). Handlers throw `AppError`; Zod validation errors,
 * Fastify's own 4xx errors, rate limits and anything unexpected are all mapped to a
 * `Problem` with a code from `@pingdost/shared-types`. Details never contain secrets or
 * user input.
 */
import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import {
  ERROR_STATUS,
  errorCodeForStatus,
  PROBLEM_CONTENT_TYPE,
  problemType,
  type ErrorCode,
  type Problem,
} from '@pingdost/shared-types';

export interface AppErrorOptions {
  /** A fixed, safe explanation for the client. */
  detail?: string;
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.detail ?? code, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.detail = options.detail;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** "USERNAME_TAKEN" → "Username taken". */
export function titleFor(code: ErrorCode): string {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toProblem(
  code: ErrorCode,
  extra: Partial<Omit<Problem, 'code' | 'type' | 'title' | 'status'>> = {},
): Problem {
  return {
    type: problemType(code),
    title: titleFor(code),
    status: ERROR_STATUS[code],
    code,
    ...extra,
  };
}

function problemFor(error: FastifyError | AppError | Error): {
  problem: Problem;
  unexpected: boolean;
} {
  if (error instanceof AppError) {
    return {
      problem: toProblem(error.code, {
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
      }),
      unexpected: false,
    };
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const context = 'validationContext' in error ? String(error.validationContext) : 'body';
    return {
      problem: toProblem('VALIDATION_FAILED', {
        errors: error.validation.map((issue) => ({
          path: `${context}${issue.instancePath.replaceAll('/', '.')}`,
          message: issue.message ?? 'is invalid',
        })),
      }),
      unexpected: false,
    };
  }
  if (isResponseSerializationError(error)) {
    return { problem: toProblem('INTERNAL'), unexpected: true };
  }
  const status = 'statusCode' in error ? error.statusCode : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Fastify's own client errors: malformed JSON, body too large, unsupported media type.
    const code = errorCodeForStatus(status);
    return { problem: { ...toProblem(code), status }, unexpected: false };
  }
  return { problem: toProblem('INTERNAL'), unexpected: true };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    const { problem, unexpected } = problemFor(error);
    if (unexpected) request.log.error({ err: error }, 'request failed');
    if (problem.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(problem.retryAfterSeconds));
    }
    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).type(PROBLEM_CONTENT_TYPE).send(toProblem('NOT_FOUND')),
  );
}
