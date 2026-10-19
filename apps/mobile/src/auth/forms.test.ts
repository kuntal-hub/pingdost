import { describe, expect, it } from 'vitest';

import { describeError } from '@/api/errors';
import { validate } from '@/forms/validation';
import { ApiError } from '@pingdost/api-client';

import {
  LoginFormSchema,
  OtpFormSchema,
  RegisterFormSchema,
  ResetPasswordFormSchema,
  UsernameFormSchema,
} from './forms';

describe('form schemas', () => {
  it('accepts a registration and normalizes it like the server', () => {
    const result = validate(RegisterFormSchema, {
      username: ' Alice.Dev ',
      email: ' Alice@Example.COM ',
      password: 'correct horse',
      confirmPassword: 'correct horse',
    });
    expect(result).toEqual({
      ok: true,
      data: {
        username: 'alice.dev',
        email: 'alice@example.com',
        password: 'correct horse',
        confirmPassword: 'correct horse',
      },
    });
  });

  it('reports one readable message per field', () => {
    const result = validate(RegisterFormSchema, {
      username: 'a!',
      email: 'not-an-email',
      password: 'short',
      confirmPassword: 'other',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        username: 'At least 3 characters',
        email: 'Enter a valid email address',
        password: 'At least 10 characters',
        confirmPassword: 'Passwords do not match',
      },
    });

    const mismatch = validate(RegisterFormSchema, {
      username: 'alice',
      email: 'alice@example.com',
      password: 'correct horse',
      confirmPassword: 'correct horsf',
    });
    expect(mismatch).toEqual({ ok: false, errors: { confirmPassword: 'Passwords do not match' } });
  });

  it('uses the shared pattern messages', () => {
    expect(validate(UsernameFormSchema, { username: 'bad name' })).toEqual({
      ok: false,
      errors: { username: 'Letters, digits, _ and . only' },
    });
    expect(validate(OtpFormSchema, { email: 'a@b.co', otp: '12a456' })).toEqual({
      ok: false,
      errors: { otp: 'Must be 6 digits' },
    });
  });

  it('checks login and reset forms', () => {
    expect(validate(LoginFormSchema, { identifier: '', password: '' })).toEqual({
      ok: false,
      errors: { identifier: 'At least 3 characters', password: 'Required' },
    });
    expect(
      validate(ResetPasswordFormSchema, {
        email: 'a@b.co',
        otp: '123456',
        newPassword: 'long enough!',
        confirmPassword: 'long enough?',
      }),
    ).toEqual({ ok: false, errors: { confirmPassword: 'Passwords do not match' } });
  });
});

describe('describeError', () => {
  const http = (
    status: number,
    code: ConstructorParameters<typeof ApiError>[2]['code'],
    problem?: object,
  ) =>
    new ApiError('http', `POST /x failed: ${status} ${code}`, {
      status,
      code,
      problem: problem as never,
    });

  it('maps server codes to messages and fields', () => {
    expect(describeError(http(409, 'EMAIL_TAKEN'))).toEqual({
      message: 'This email already has an account. Log in instead.',
      field: 'email',
    });
    expect(describeError(http(400, 'OTP_INVALID'))).toMatchObject({ field: 'otp' });
    expect(describeError(http(401, 'INVALID_CREDENTIALS')).message).toBe(
      'Wrong username, email or password.',
    );
  });

  it('includes wait times and validation fields', () => {
    const cooldown = http(429, 'OTP_RESEND_COOLDOWN', {
      type: 'x',
      title: 'wait',
      status: 429,
      code: 'OTP_RESEND_COOLDOWN',
      retryAfterSeconds: 25,
    });
    expect(describeError(cooldown)).toEqual({
      message: 'Wait 25 s before requesting another code.',
      retryAfterSeconds: 25,
    });
    const locked = http(423, 'ACCOUNT_LOCKED', {
      type: 'x',
      title: 'locked',
      status: 423,
      code: 'ACCOUNT_LOCKED',
      retryAfterSeconds: 600,
    });
    expect(describeError(locked).message).toBe('Too many failed attempts. Try again in 10 min.');
    const invalid = http(400, 'VALIDATION_FAILED', {
      type: 'x',
      title: 'invalid',
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'username', message: 'Too short' }],
    });
    expect(describeError(invalid)).toEqual({
      message: 'Check the highlighted fields.',
      field: 'username',
    });
  });

  it('flags offline failures and accepts overrides', () => {
    const offline = new ApiError('network', 'POST /x failed: no response', { code: 'UNAVAILABLE' });
    expect(describeError(offline)).toMatchObject({ offline: true });
    expect(
      describeError(http(503, 'UNAVAILABLE'), { UNAVAILABLE: 'Google sign-in is not set up.' })
        .message,
    ).toBe('Google sign-in is not set up.');
    expect(describeError(new Error('boom')).message).toBe('Something went wrong. Try again.');
  });
});
