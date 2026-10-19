import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { api, authStore } from '@/api';
import { describeError } from '@/api/errors';
import { EmailFormSchema, OtpFormSchema } from '@/auth/forms';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { useForm } from '@/forms/use-form';
import { validate } from '@/forms/validation';
import { useCountdown } from '@/hooks/use-countdown';

/** Matches the server's default `EMAIL_OTP_RESEND_COOLDOWN_SECONDS`. */
const RESEND_COOLDOWN_SECONDS = 30;

export function VerifyOtpScreen() {
  // `sent`: registration just sent a code. `resend`: send one now (login found the address
  // unverified, and the first code may have expired).
  const params = useLocalSearchParams<{ email?: string; sent?: string; resend?: string }>();
  const form = useForm(OtpFormSchema, { email: params.email ?? '', otp: '' });
  const [cooldown, startCooldown] = useCountdown(params.sent ? RESEND_COOLDOWN_SECONDS : 0);
  const [resendState, setResendState] = useState<{ tone: 'info' | 'error'; message: string }>();
  const [resending, setResending] = useState(false);

  async function resend(): Promise<void> {
    const email = validate(EmailFormSchema, { email: form.values.email });
    if (!email.ok) {
      setResendState({ tone: 'error', message: 'Enter your email address first.' });
      return;
    }
    setResending(true);
    try {
      await api.auth.resendVerification(email.data.email);
      startCooldown(RESEND_COOLDOWN_SECONDS);
      setResendState({ tone: 'info', message: 'We sent a new code. It may take a minute.' });
    } catch (error) {
      const described = describeError(error);
      if (described.retryAfterSeconds) startCooldown(described.retryAfterSeconds);
      setResendState({ tone: 'error', message: described.message });
    } finally {
      setResending(false);
    }
  }

  useEffect(() => {
    if (params.resend && params.email) void resend();
    // Once, on arrival.
  }, []);

  const submit = () =>
    form.submit(async (body) => {
      await authStore.getState().signIn(await api.auth.verifyEmail(body));
    });

  return (
    <Screen
      title="Check your email"
      subtitle={
        params.email
          ? `Enter the 6-digit code we sent to ${params.email}.`
          : 'Enter your email address and the 6-digit code we sent to it.'
      }
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
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        {...form.field('otp')}
      />
      {form.formError && <Notice tone="error" message={form.formError.message} />}
      <Button label="Verify" loading={form.submitting} onPress={() => void submit()} />
      <Button
        label={cooldown > 0 ? `Resend code (${cooldown} s)` : 'Resend code'}
        variant="ghost"
        disabled={cooldown > 0}
        loading={resending}
        onPress={() => void resend()}
      />
      {resendState && <Notice tone={resendState.tone} message={resendState.message} />}
    </Screen>
  );
}
