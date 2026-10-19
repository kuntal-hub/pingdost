// Google Sign-In through the free "Original" API of @react-native-google-signin/google-signin.
// The app only needs an ID token for `POST /v1/auth/google`, requested for the Web client ID
// that the server accepts (`GOOGLE_CLIENT_IDS`). Android needs no config plugin without
// Firebase; iOS (Phase 28) adds the plugin with `iosUrlScheme`.
import {
  GoogleSignin,
  isCancelledResponse,
  isErrorWithCode,
  statusCodes,
} from '@react-native-google-signin/google-signin';

import { publicConfig } from '@/config';

export const googleSignInAvailable = publicConfig?.googleWebClientId !== undefined;

let configured = false;

function configure(): void {
  if (configured || !publicConfig?.googleWebClientId) return;
  GoogleSignin.configure({ webClientId: publicConfig.googleWebClientId });
  configured = true;
}

export class GoogleSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleSignInError';
  }
}

/** Shows Google's account picker; resolves the ID token, or null if the user cancelled. */
export async function getGoogleIdToken(): Promise<string | null> {
  configure();
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();
    if (isCancelledResponse(response)) return null;
    if (!response.data.idToken) throw new GoogleSignInError('Google did not return an ID token.');
    return response.data.idToken;
  } catch (error) {
    if (error instanceof GoogleSignInError) throw error;
    if (isErrorWithCode(error)) {
      if (error.code === statusCodes.SIGN_IN_CANCELLED) return null;
      if (error.code === statusCodes.IN_PROGRESS) {
        throw new GoogleSignInError('Google sign-in is already open.');
      }
      if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        throw new GoogleSignInError('Google Play services are missing or out of date.');
      }
      // Android's DEVELOPER_ERROR (10): the Android OAuth client's package or SHA-1 does
      // not match this build, or the web client ID is wrong.
      if (String(error.code) === '10') {
        throw new GoogleSignInError(
          "Google sign-in isn't set up for this build (check the Android client's SHA-1).",
        );
      }
    }
    throw new GoogleSignInError('Google sign-in failed. Try again.');
  }
}

/** Forgets the Google account choice, so the next sign-in shows the picker again. */
export async function signOutOfGoogle(): Promise<void> {
  if (!configured) return;
  await GoogleSignin.signOut();
}
