import { useRouter } from 'expo-router';

import { api } from '@/api';
import { RegisterFormSchema } from '@/auth/forms';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { useForm } from '@/forms/use-form';

export function RegisterScreen() {
  const router = useRouter();
  const form = useForm(RegisterFormSchema, {
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const submit = () =>
    form.submit(async ({ username, email, password }) => {
      await api.auth.register({ username, email, password });
      router.push({ pathname: '/verify-otp', params: { email, sent: '1' } });
    });

  return (
    <Screen
      title="Create account"
      subtitle="We email you a code to confirm the address."
      offlineBanner
    >
      <TextField
        label="Username"
        hint="3–20 characters: letters, digits, _ and ."
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username-new"
        textContentType="username"
        {...form.field('username')}
      />
      <TextField
        label="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        {...form.field('email')}
      />
      <TextField
        label="Password"
        hint="At least 10 characters"
        secureTextEntry
        autoComplete="password-new"
        textContentType="newPassword"
        {...form.field('password')}
      />
      <TextField
        label="Confirm password"
        secureTextEntry
        autoComplete="password-new"
        textContentType="newPassword"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        {...form.field('confirmPassword')}
      />
      {form.formError && <Notice tone="error" message={form.formError.message} />}
      <Button label="Create account" loading={form.submitting} onPress={() => void submit()} />
    </Screen>
  );
}
