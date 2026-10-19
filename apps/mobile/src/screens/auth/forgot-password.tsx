import { useRouter } from 'expo-router';

import { api } from '@/api';
import { EmailFormSchema } from '@/auth/forms';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { useForm } from '@/forms/use-form';

export function ForgotPasswordScreen() {
  const router = useRouter();
  const form = useForm(EmailFormSchema, { email: '' });

  const submit = () =>
    form.submit(async ({ email }) => {
      // The server answers the same whether or not the address has an account.
      await api.auth.forgotPassword(email);
      router.push({ pathname: '/reset-password', params: { email, sent: '1' } });
    });

  return (
    <Screen
      title="Reset password"
      subtitle="If the address has an account, we email it a code."
      offlineBanner
    >
      <TextField
        label="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        returnKeyType="send"
        onSubmitEditing={() => void submit()}
        {...form.field('email')}
      />
      {form.formError && <Notice tone="error" message={form.formError.message} />}
      <Button label="Send code" loading={form.submitting} onPress={() => void submit()} />
    </Screen>
  );
}
