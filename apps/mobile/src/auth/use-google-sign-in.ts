import { useState } from 'react';

import { api, authStore } from '@/api';
import { describeError } from '@/api/errors';

import { getGoogleIdToken, googleSignInAvailable, GoogleSignInError } from './google';

/** Google sign-in for the welcome and login screens; the root layout routes the result. */
export function useGoogleSignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await getGoogleIdToken();
      if (!idToken) return;
      await authStore.getState().signIn(await api.auth.google(idToken));
    } catch (caught) {
      setError(
        caught instanceof GoogleSignInError
          ? caught.message
          : describeError(caught, {
              UNAVAILABLE: 'Google sign-in is not set up on the server yet.',
            }).message,
      );
    } finally {
      setBusy(false);
    }
  }

  return { available: googleSignInAvailable, busy, error, signIn };
}
