// Form schemas for the auth and profile screens, built from the shared request schemas so
// the app checks exactly what the server checks.
import { z } from 'zod';

import {
  DisplayNameSchema,
  EmailSchema,
  LoginRequestSchema,
  OtpSchema,
  PasswordSchema,
  UsernameSchema,
} from '@pingdost/shared-types';

const passwordsMatch = {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
};

export const RegisterFormSchema = z
  .object({
    username: UsernameSchema,
    email: EmailSchema,
    password: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((form) => form.password === form.confirmPassword, passwordsMatch);

export const LoginFormSchema = LoginRequestSchema;

export const OtpFormSchema = z.object({ email: EmailSchema, otp: OtpSchema });

export const EmailFormSchema = z.object({ email: EmailSchema });

export const ResetPasswordFormSchema = z
  .object({
    email: EmailSchema,
    otp: OtpSchema,
    newPassword: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((form) => form.newPassword === form.confirmPassword, passwordsMatch);

export const UsernameFormSchema = z.object({ username: UsernameSchema });

export const ProfileFormSchema = z.object({ displayName: DisplayNameSchema });
