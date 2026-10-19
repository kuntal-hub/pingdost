// The app's API client and auth store, created together: the client reads the access token
// from the store and asks it to refresh on `TOKEN_EXPIRED`.
import { createAuthStore } from '@/auth/auth-store';
import { signOutOfGoogle } from '@/auth/google';
import { secureSessionStorage } from '@/auth/session-storage';
import { publicConfig } from '@/config';
import {
  accountApi,
  authApi,
  createApiClient,
  devicesApi,
  keysApi,
  securityApi,
} from '@pingdost/api-client';

const client = createApiClient({
  // Without a config the root layout shows the config error before any request is made.
  baseUrl: publicConfig?.apiUrl ?? 'http://invalid.localhost',
  getAccessToken: () => authStore.getState().accessToken(),
  onRefresh: () => authStore.getState().refresh(),
});

export const api = {
  auth: authApi(client),
  account: accountApi(client),
  devices: devicesApi(client),
  keys: keysApi(client),
  security: securityApi(client),
};

export const authStore = createAuthStore({
  storage: secureSessionStorage,
  refresh: (refreshToken) => api.auth.refresh(refreshToken),
  logout: () => api.auth.logout(),
  afterLogout: signOutOfGoogle,
});
