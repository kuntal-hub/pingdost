import { api, authStore } from '@/api';
import { UsernameFormSchema } from '@/auth/forms';
import { Button } from '@/components/button';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { useForm } from '@/forms/use-form';

/** A new Google account picks its username before anything else. */
export function GoogleUsernameScreen() {
  const form = useForm(UsernameFormSchema, { username: '' });

  const submit = () =>
    form.submit(async ({ username }) => {
      await authStore.getState().setUser(await api.auth.completeGoogle(username));
    });

  return (
    <Screen
      title="Choose a username"
      subtitle="People find you on PingDost by your exact username."
      offlineBanner
      headerless
    >
      <TextField
        label="Username"
        hint="3–20 characters: letters, digits, _ and ."
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username-new"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        {...form.field('username')}
      />
      {form.formError && <Notice tone="error" message={form.formError.message} />}
      <Button label="Continue" loading={form.submitting} onPress={() => void submit()} />
      <Button
        label="Use another account"
        variant="ghost"
        onPress={() => void authStore.getState().logout()}
      />
    </Screen>
  );
}
