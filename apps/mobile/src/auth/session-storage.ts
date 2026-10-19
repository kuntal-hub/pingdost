// The session in expo-secure-store (Android Keystore-backed). A value that fails to parse
// is treated as signed out rather than crashing the app.
import * as SecureStore from 'expo-secure-store';

import { SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';

import { StoredSessionSchema, type SessionStorage } from './session';

export const secureSessionStorage: SessionStorage = {
  async load() {
    const raw = await SecureStore.getItemAsync(SECRET_ITEMS.session, SECURE_STORE_OPTIONS);
    if (raw === null) return null;
    try {
      const parsed = StoredSessionSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  save: (session) =>
    SecureStore.setItemAsync(SECRET_ITEMS.session, JSON.stringify(session), SECURE_STORE_OPTIONS),
  clear: () => SecureStore.deleteItemAsync(SECRET_ITEMS.session, SECURE_STORE_OPTIONS),
};
