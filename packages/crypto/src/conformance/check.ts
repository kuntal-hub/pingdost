// Minimal assertions for scenarios that run under Vitest and on a phone alike. Failure
// messages name the check only: never plaintext, keys or ciphertext (ARCHITECTURE A10).

export class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceError';
  }
}

export function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new ConformanceError(`check failed: ${what}`);
}

export function checkEqual(actual: unknown, expected: unknown, what: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), what);
}

/** Runs `operation` and fails unless it throws; returns the thrown value. */
export function checkThrows(operation: () => unknown, what: string): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new ConformanceError(`expected a failure: ${what}`);
}

/** One reported step for a dev screen or a test: no secrets in `detail`. */
export interface StepResult {
  id: string;
  title: string;
  ok: boolean;
  detail?: string;
}

/**
 * A short description of a failure. Crypto errors carry fixed messages from the Rust wrapper
 * and this suite's own messages name checks only, so neither contains secrets.
 */
export function describeError(error: unknown): string {
  if (error instanceof ConformanceError) return error.message;
  if (error instanceof Error) {
    const code = 'code' in error ? ` (${String(error.code)})` : '';
    return `${error.name}${code}: ${error.message}`.slice(0, 200);
  }
  return 'unknown error';
}
