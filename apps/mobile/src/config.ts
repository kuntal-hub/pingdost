// Client config from `EXPO_PUBLIC_*` variables (apps/mobile/.env; ADR 0002). Expo inlines
// only static `process.env.EXPO_PUBLIC_*` references, hence the object literal. A missing or
// invalid value leaves `publicConfig` undefined and the root layout shows `configError`.
import { loadPublicConfig, type PublicConfig } from '@pingdost/config/public';

function load(): { config?: PublicConfig; error?: string } {
  try {
    const config = loadPublicConfig(
      {
        EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
        EXPO_PUBLIC_WS_URL: process.env.EXPO_PUBLIC_WS_URL,
        EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
      },
      'EXPO_PUBLIC_',
    );
    return { config };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'invalid configuration' };
  }
}

const loaded = load();

export const publicConfig = loaded.config;
export const configError = loaded.error;
