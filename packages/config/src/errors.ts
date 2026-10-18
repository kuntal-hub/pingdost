import type { ZodError } from 'zod';

/**
 * Thrown when configuration is invalid. Each issue names a variable and the problem,
 * never its value, so the message is safe to log (ARCHITECTURE A10).
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(scope: 'server' | 'public', issues: readonly string[]) {
    super(`Invalid ${scope} configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Drops unset and blank values, so `KEY=` in an .env file counts as unset. */
export function withoutBlankValues(env: Readonly<Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') result[key] = value;
  }
  return result;
}

/** Turns Zod issues into `KEY: problem` lines. Zod's messages do not include input values. */
export function formatZodIssues(
  error: ZodError,
  input: Readonly<Record<string, string>>,
  keyPrefix = '',
): string[] {
  return error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '(root)');
    const path = [keyPrefix + key, ...issue.path.slice(1).map(String)].join('.');
    const missing = issue.code === 'invalid_type' && input[key] === undefined;
    return `${path}: ${missing ? 'is required' : issue.message}`;
  });
}
