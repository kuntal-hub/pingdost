import { useLocalSearchParams, useRouter } from 'expo-router';

import { api, authStore } from '@/api';
import { errorCode } from '@/api/errors';
import { LoginFormSchema } from '@/auth/forms';
import { useGoogleSignIn } from '@/auth/use-google-sign-in';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { useForm } from '@/forms/use-form';

export function LoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ notice?: string }>();
  const google = useGoogleSignIn();
  const form = useForm(LoginFormSchema, { identifier: '', password: '' });

  const submit = () =>
    form.submit(async (body) => {
      try {
        await authStore.getState().signIn(await api.auth.login(body));
      } catch (error) {
        if (errorCode(error) !== 'EMAIL_NOT_VERIFIED') throw error;
        const email = body.identifier.includes('@') ? body.identifier : undefined;
        router.push({
          pathname: '/verify-otp',
          params: { ...(email ? { email } : {}), resend: '1' },
        });
      }
    });

  return (
    <Screen title="Log in" offlineBanner>
      {params.notice === 'password-reset' && (
        <Notice tone="success" message="Password changed. Log in with your new password." />
      )}
      <TextField
        label="Email or username"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        {...form.field('identifier')}
      />
      <TextField
        label="Password"
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        {...form.field('password')}
      />
      {form.formError && <Notice tone="error" message={form.formError.message} />}
      <Button label="Log in" loading={form.submitting} onPress={() => void submit()} />
      <Button
        label="Forgot password?"
        variant="ghost"
        onPress={() => router.push('/forgot-password')}
      />
      {google.available && (
        <Button
          label="Continue with Google"
          variant="secondary"
          loading={google.busy}
          onPress={() => void google.signIn()}
        />
      )}
      {google.error && <Notice tone="error" message={google.error} />}
    </Screen>
  );
}
