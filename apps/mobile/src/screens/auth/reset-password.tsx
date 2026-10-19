import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

import { api } from '@/api';
import { describeError } from '@/api/errors';
import { ResetPasswordFormSchema } from '@/auth/forms';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { useForm } from '@/forms/use-form';
import { useCountdown } from '@/hooks/use-countdown';

const RESEND_COOLDOWN_SECONDS = 30;

export function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string; sent?: string }>();
  const form = useForm(ResetPasswordFormSchema, {
    email: params.email ?? '',
    otp: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [cooldown, startCooldown] = useCountdown(params.sent ? RESEND_COOLDOWN_SECONDS : 0);
  const [resendState, setResendState] = useState<{ tone: 'info' | 'error'; message: string }>();

  async function resend(): Promise<void> {
    try {
      await api.auth.forgotPassword(form.values.email);
      startCooldown(RESEND_COOLDOWN_SECONDS);
      setResendState({
        tone: 'info',
        message: 'If the address has an account, a new code is on its way.',
      });
    } catch (error) {
      const described = describeError(error);
      if (described.retryAfterSeconds) startCooldown(described.retryAfterSeconds);
      setResendState({ tone: 'error', message: described.message });
    }
  }

  const submit = () =>
    form.submit(async ({ email, otp, newPassword }) => {
      await api.auth.resetPassword({ email, otp, newPassword });
      router.dismissTo({ pathname: '/login', params: { notice: 'password-reset' } });
    });

  return (
    <Screen
      title="Choose a new password"
      subtitle={params.email ? `Enter the code we sent to ${params.email}.` : undefined}
      offlineBanner
    >
      {!params.email && (
        <TextField
          label="Email"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          {...form.field('email')}
        />
      )}
      <TextField
        label="Code"
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        {...form.field('otp')}
      />
      <TextField
        label="New password"
        hint="At least 10 characters"
        secureTextEntry
        autoComplete="password-new"
        textContentType="newPassword"
        {...form.field('newPassword')}
      />
      <TextField
        label="Confirm new password"
        secureTextEntry
        autoComplete="password-new"
        textContentType="newPassword"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        {...form.field('confirmPassword')}
      />
      {form.formError && <Notice tone="error" message={form.formError.message} />}
      <Button label="Change password" loading={form.submitting} onPress={() => void submit()} />
      <Button
        label={cooldown > 0 ? `Resend code (${cooldown} s)` : 'Resend code'}
        variant="ghost"
        disabled={cooldown > 0 || form.values.email === ''}
        onPress={() => void resend()}
      />
      {resendState && <Notice tone={resendState.tone} message={resendState.message} />}
    </Screen>
  );
}
