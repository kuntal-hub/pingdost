// Form state for the auth and settings screens: values, per-field errors from the shared
// schemas, and server errors mapped to their field or to the form.
import { useState } from 'react';
import type { z } from 'zod';

import { describeError, type UserFacingError } from '@/api/errors';
import type { ErrorCode } from '@pingdost/shared-types';

import { validate, type FieldErrors } from './validation';

export function useForm<T, K extends string>(schema: z.ZodType<T>, initial: Record<K, string>) {
  const [values, setValues] = useState<Record<K, string>>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<UserFacingError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function setValue(name: K, value: string): void {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  }

  /** Props for a `TextField`. */
  function field(name: K) {
    return {
      value: values[name],
      onChangeText: (text: string) => setValue(name, text),
      error: errors[name],
    };
  }

  /** Validates, then runs `action`; a thrown error lands on its field or on the form. */
  async function submit(
    action: (data: T) => Promise<void>,
    overrides?: Partial<Record<ErrorCode, string>>,
  ): Promise<void> {
    if (submitting) return;
    const result = validate(schema, values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await action(result.data);
    } catch (error) {
      const described = describeError(error, overrides);
      if (described.field !== undefined && described.field in values) {
        setErrors((current) => ({ ...current, [described.field as string]: described.message }));
      } else {
        setFormError(described);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return { values, setValue, field, errors, formError, setFormError, submitting, submit };
}
