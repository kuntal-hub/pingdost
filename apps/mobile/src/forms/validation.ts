// Validates form values with the shared Zod schemas and turns issues into short field
// messages. Issues can carry the input, so they are never logged.
import type { z } from 'zod';

export type FieldErrors = Partial<Record<string, string>>;

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A user-facing message for one issue. */
export function issueMessage(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_small':
      if (issue.origin !== 'string') break;
      return Number(issue.minimum) <= 1
        ? 'Required'
        : `At least ${String(issue.minimum)} characters`;
    case 'too_big':
      if (issue.origin !== 'string') break;
      return `At most ${String(issue.maximum)} characters`;
    case 'invalid_format':
      if (issue.format === 'email') return 'Enter a valid email address';
      // The shared schemas give their patterns readable messages; Zod's default is not.
      return issue.message.startsWith('Invalid') ? 'Invalid format' : capitalize(issue.message);
    case 'custom':
      return capitalize(issue.message);
    default:
      break;
  }
  return 'Invalid value';
}

/** Parses `values`; on failure returns the first message per top-level field. */
export function validate<T>(schema: z.ZodType<T>, values: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(values);
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? 'form');
    errors[field] ??= issueMessage(issue);
  }
  return { ok: false, errors };
}
