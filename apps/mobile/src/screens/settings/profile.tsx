import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';

import { describeError } from '@/api/errors';
import { ProfileFormSchema } from '@/auth/forms';
import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list-row';
import { Notice } from '@/components/notice';
import { Screen } from '@/components/screen';
import { TextField } from '@/components/text-field';
import { useForm } from '@/forms/use-form';
import { useAccount } from '@/settings/account';
import { AvatarError, avatarUploadsEnabled, pickAndUploadAvatar } from '@/settings/avatar';
import { usePalette } from '@/theme/theme-root';

type Status = { tone: 'error' | 'success'; message: string } | null;

export function ProfileScreen() {
  const palette = usePalette();
  const me = useAccount((state) => state.me);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Hidden until the server confirms it can sign uploads (Cloudinary configured).
  const [avatars, setAvatars] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const form = useForm(ProfileFormSchema, { displayName: me?.displayName ?? '' });

  useEffect(() => {
    useAccount
      .getState()
      .load()
      .then(
        (loaded) => form.setValue('displayName', loaded.displayName ?? ''),
        (error: unknown) => setLoadError(describeError(error).message),
      );
    avatarUploadsEnabled().then(setAvatars, () => setAvatars(false));
    // Once, on arrival.
  }, []);

  const save = () =>
    form.submit(async ({ displayName }) => {
      await useAccount.getState().update({ displayName });
      setStatus({ tone: 'success', message: 'Saved.' });
    });

  async function changeAvatar(remove: boolean): Promise<void> {
    setAvatarBusy(true);
    setStatus(null);
    try {
      const avatarUrl = remove ? null : await pickAndUploadAvatar();
      if (avatarUrl === null && !remove) return;
      await useAccount.getState().update({ avatarUrl });
      setStatus({ tone: 'success', message: remove ? 'Picture removed.' : 'Picture updated.' });
    } catch (error) {
      const message = error instanceof AvatarError ? error.message : describeError(error).message;
      setStatus({ tone: 'error', message });
    } finally {
      setAvatarBusy(false);
    }
  }

  if (!me) {
    return (
      <Screen offlineBanner>
        {loadError ? (
          <Notice tone="error" message={loadError} />
        ) : (
          <ActivityIndicator color={palette.primary} />
        )}
      </Screen>
    );
  }

  return (
    <Screen offlineBanner>
      {avatars && (
        <View className="items-center gap-3">
          {me.avatarUrl && (
            <Image
              source={{ uri: me.avatarUrl }}
              accessibilityIgnoresInvertColors
              accessibilityLabel="Your profile picture"
              className="h-[96px] w-[96px] rounded-full"
            />
          )}
          <View className="flex-row gap-3">
            <Button
              label={me.avatarUrl ? 'Change picture' : 'Add picture'}
              variant="secondary"
              loading={avatarBusy}
              onPress={() => void changeAvatar(false)}
            />
            {me.avatarUrl && (
              <Button
                label="Remove"
                variant="ghost"
                disabled={avatarBusy}
                onPress={() => void changeAvatar(true)}
              />
            )}
          </View>
        </View>
      )}

      <TextField
        label="Display name"
        hint="Shown to people you chat with."
        autoComplete="name"
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        {...form.field('displayName')}
      />
      {form.formError && <Notice tone="error" message={form.formError.message} />}
      <Button label="Save" loading={form.submitting} onPress={() => void save()} />
      {status && <Notice tone={status.tone} message={status.message} />}

      <ListSection title="Account">
        <ListRow title="Username" subtitle={me.username ? `@${me.username}` : 'Not set'} />
        <ListRow title="Email" subtitle={me.email} />
        <ListRow
          title="Sign-in methods"
          subtitle={me.authProviders
            .map((provider) => (provider === 'google' ? 'Google' : 'Password'))
            .join(', ')}
        />
      </ListSection>
    </Screen>
  );
}
